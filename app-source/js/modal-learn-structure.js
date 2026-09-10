'use strict'

const i18n = require( './i18n.min' )

// Polyfill: make electron-store work in renderer
try {
	const electron = require( 'electron' )
	const remote = require( '@electron/remote' )
	if( !electron.app ) electron.app = remote.app
} catch( e ) {}

const { ipcRenderer } = require( 'electron' )

const Store = require( 'electron-store' )
let store
try {
	store = new Store()
} catch( e ) {
	store = { get: () => null, set: () => {} }
}

const $ = require( 'jquery' )
const jqueryI18next = require( 'jquery-i18next' )
const log = require( 'electron-log' )
const aiClient = require( './ai-client.min' )

jqueryI18next.init(i18n, $)



//note(dgmid): log exceptions

window.onerror = function( error, url, line ) {
	
	ipcRenderer.send( 'error-in-render', {error, url, line} )
}



//note(dgmid): set lang & localize strings

$('html').attr('lang', i18n.language)
$('header').localize()
$('.section-title').localize()
$('label').localize()
$('button').localize()
$('.hint').localize()



//note(dgmid): state

let context 			= null,		// { folderId, folderName, children: [{name, count, samples}], tagExamples: [{tag, count, examples}] } from main window
	detectedFolderNames = [],
	detectedTags 		= [],		// [{tag, count, examples}] editable before saving
	analyzing 			= false



//note(dgmid): sanitize example titles for the prompt/UI — strip double quotes,
//newlines and excess whitespace so they can't break the quoted examples or markup

function cleanExample( s ) {
	
	return String( s || '' ).replace( /["\\]/g, '' ).replace( /[\r\n\t]+/g, ' ' ).replace( /\s{2,}/g, ' ' ).trim()
}



//note(dgmid): fallback models to try when the primary model is overloaded

const FALLBACK_MODELS = [
	'gemini-3.5-flash-lite',
	'gemini-3.1-flash-lite',
	'gemini-2.5-flash',
	'gemini-3.5-flash'
]

//note(dgmid): models Google has retired - never sent to the API, and when the saved
//config still names one the run silently substitutes the listed replacement instead of
//poisoning every batch with an HTTP 400 ("...is no longer available to new users...").
const RETIRED_MODELS = [ 'gemini-2.5-flash-lite' ]

const MODEL_REPLACEMENTS = {
	'gemini-2.5-flash-lite': 'gemini-3.5-flash-lite'
}

const DEFAULT_MODEL = 'gemini-2.5-flash'

let unavailableModels = {}	// models found retired / not-found at runtime this session - skipped later



//note(dgmid): is this a MODEL-AVAILABILITY error? When Google retires a model (or the
//configured name is wrong), every call fails with an HTTP 400 - retrying the same model
//is pointless; the run must skip to the next one and blacklist it for the session.

function isModelUnavailable( message ) {
	
	let m = (message || '').toLowerCase()
	
	return m.includes( 'no longer available' ) ||
	       m.includes( 'model not found' ) ||
	       m.includes( 'is not available' ) ||
	       m.includes( 'not found for api version' ) ||
	       m.includes( 'does not exist' ) ||
	       ( m.includes( 'models/' ) && m.includes( '404' ) )
}



//note(dgmid): the model to actually send - the configured one, unless Google retired it
//(then Google's suggested replacement is used instead, and the user is told once).

function resolvePrimaryModel( configured ) {
	
	let model = configured || DEFAULT_MODEL
	
	if( RETIRED_MODELS.includes( model ) ) {
		
		let replacement = MODEL_REPLACEMENTS[ model ]
		
		log.warn( `saved model ${model} has been retired by Google - using ${replacement} instead` )
		
		return replacement
	}
	
	return model
}



//note(dgmid): ordered list of models to try for one call - the primary first, then the
//fallbacks, minus anything retired or already known to be unavailable this session.

function buildModelsToTry( primaryModel ) {
	
	//note(dgmid): only Gemini has a multi-model free fallback chain. OpenRouter and
	//local servers use their single configured model — sending Gemini fallback names
	//to another provider's endpoint would fail every call.
	if( aiClient.normalizeConfig( store.get( 'aiConfig' ) || {} ).provider !== 'gemini' ) {
		
		return [ primaryModel ]
	}
	
	let list = [ primaryModel ]
	
	for( let fb of FALLBACK_MODELS ) {
		
		if( fb !== primaryModel && !RETIRED_MODELS.includes( fb ) && !unavailableModels[ fb ] ) {
			
			list.push( fb )
		}
	}
	
	return list
}



//note(dgmid): load context + config and check selection

function loadConfig() {
	
	let config = store.get( 'aiConfig' ) || {}
	
	context = store.get( '_learnStructureContext' )
	
	let problem = aiClient.configProblem( aiClient.normalizeConfig( config ) )
	
	if( problem ) {
		
		$('#cfg-errors').html(
			i18n.t( 'learn:error.' + problem.code, problem.message )
		).show()
		
		$('#btn-start').prop('disabled', true)
		return null
	}
	
	$('#cfg-model').text( resolvePrimaryModel( config.model ) )
	
	let folderName 	= ( context && context.folderName ) ? context.folderName : i18n.t('learn:label.home', 'Home'),
		children 	= ( context && context.children ) ? context.children : [],
		tags 		= ( context && context.tagExamples ) ? context.tagExamples : []
	
	detectedTags = tags
	
	$('#cfg-folder').text( folderName )
	$('#cfg-tags').text( tags.length )
	
	if( children.length === 0 ) {
		
		$('#cfg-children').html(
			'<span style="color:#856404;">' +
			i18n.t('learn:label.nochildren', 'No subfolders found in this folder — select a folder with subfolders first') +
			'</span>'
		)
		$('#btn-start').prop('disabled', true)
		
	} else {
		
		$('#cfg-children').text( children.length )
		$('#btn-start').prop('disabled', false)
	}
	
	return config
}

loadConfig()



//note(dgmid): show status in progress bar

function setProgress( current, total, label ) {
	
	let pct = total > 0 ? Math.round( current / total * 100 ) : 0
	
	$('#progress-fill').css( 'width', pct + '%' )
	$('#progress-text').text( label || `${current} / ${total}` )
}



//note(dgmid): check if a Gemini error is a transient server issue (high demand, rate limit, etc.)

function isTransientError( message ) {
	
	let m = (message || '').toLowerCase()
	
	return m.includes('high demand') ||
	       m.includes('rate limit') ||
	       m.includes('too many requests') ||
	       m.includes('temporarily') ||
	       m.includes('quota') ||
	       m.includes('429') ||
	       m.includes('resource exhausted')
}



//note(dgmid): build the prompt that deduces the organizing criterion

function buildLearnPrompt( ctx ) {
	
	let childrenTxt = ( ctx.children || [] ).slice( 0, 40 ).map( c => {
		
		let samples = ( c.samples || [] ).map( s => `"${cleanExample( s ).substring( 0, 60 )}"` ).join( ', ' )
		
		return `- "${cleanExample( c.name ).substring( 0, 60 )}" (${c.count} bookmarks)${samples ? ' — samples: ' + samples : ''}`
	}).join('\n')
	
	return `You analyze how a user organized bookmarks into folders. Deduce the organizing criterion they follow.

Folder being analyzed: "${ctx.folderName}"
Its subfolders (name | bookmark count | sample titles):
${childrenTxt}

Respond ONLY with a JSON object, no other text, no markdown:
{"name": "short profile name (2-4 words)", "description": "2-3 sentence description of the organizing criterion", "folderNames": ["a representative existing folder name", "..."]}

If the structure shows NO clear organizing criterion, respond with:
{"name": "", "description": "", "folderNames": []}`
}



//note(dgmid): parse the Gemini response into { name, description, folderNames }

function parseLearnResponse( data ) {
	
	let text = aiClient.extractTextAny( data )
	
	if( !text ) {
		log.warn( `learn-structure: Gemini returned empty response` )
		return null
	}
	
	let jsonStr = text.trim()
	
	// Handle markdown code blocks (```json ... ```)
	let codeBlockMatch = jsonStr.match( /```(?:json)?\s*([\s\S]*?)```/ )
	if( codeBlockMatch ) jsonStr = codeBlockMatch[1].trim()
	
	try {
		
		let parsed = JSON.parse( jsonStr )
		
		return {
			name: String( parsed.name || '' ).trim(),
			description: String( parsed.description || '' ).trim(),
			folderNames: Array.isArray( parsed.folderNames )
				? parsed.folderNames.map( f => String( f ).trim() ).filter( Boolean )
				: []
		}
		
	} catch( e ) {
		
		return null
	}
}



//note(dgmid): provider-aware POST for the one-shot structure analysis — resolves
//{ ok, status, data } with the raw JSON so the model-unavailable / transient branches
//below stay identical regardless of provider

function learnPost( model, prompt ) {
	
	let cfg = aiClient.normalizeConfig( store.get( 'aiConfig' ) || {} )
	cfg.model = model || cfg.model
	
	let req = aiClient.buildChatRequest( cfg, prompt, 1024, { json: false } )
	
	let controller 	= new AbortController(),
		timer 		= setTimeout( () => controller.abort(), 60000 )
	
	return fetch( req.url, {
		method: 'POST',
		headers: req.headers,
		signal: controller.signal,
		body: JSON.stringify( req.body )
	}).then( async response => {
		
		let data = null
		
		try {
			data = await response.json()
		} catch( e ) {}
		
		return { ok: response.ok, status: response.status, data: data }
		
	}).finally( () => {
		
		clearTimeout( timer )
	})
}



//note(dgmid): call the configured AI provider once to deduce the criterion, with model fallback

function analyzeStructure() {
	
	let config = store.get( 'aiConfig' ) || {}
	
	let apiKey 			= config.apiKey,
		primaryModel 	= resolvePrimaryModel( config.model )
	
	if( !context || !context.children || context.children.length === 0 ) {
		
		ipcRenderer.send('show-error-box', {
			title: i18n.t('learn:error.nochildren_title', 'No Subfolders'),
			content: i18n.t('learn:error.nochildren_content', 'Select a folder that contains subfolders before learning.')
		})
		return
	}
	
	analyzing = true
	
	$('#step-start').hide()
	$('#step-progress').show()
	$('#btn-start').hide()
	$('#btn-close').text( i18n.t('learn:button.cancel', 'Cancel') )
	
	setProgress( 0, 1, i18n.t('learn:progress.analyzing', 'Analyzing folder structure…') )
	
	let modelsToTry = buildModelsToTry( primaryModel )
	
	tryModels( 0 )
	
	function tryModels( modelIndex ) {
		
		if( modelIndex >= modelsToTry.length ) {
			
			log.warn( `learn-structure: all ${modelsToTry.length} models failed` )
			analyzing = false
			showAnalyzeError()
			return
		}
		
		let model = modelsToTry[modelIndex]
		
		let prompt = buildLearnPrompt( context )
		
		learnPost( model, prompt ).then( response => {
			
			if( !response.ok ) {
				
				let data = response.data
				
				let msg = aiClient.extractErrorAny( response.status, data )
				
					if( isModelUnavailable( msg ) ) {
						
						unavailableModels[ model ] = true
						
						if( modelIndex + 1 < modelsToTry.length ) {
							
							log.warn( `learn-structure: ${model} is no longer available - falling back to ${modelsToTry[ modelIndex + 1 ]}` )
							
							return new Promise( resolve => {
								setTimeout( () => {
									tryModels( modelIndex + 1 ).then( resolve )
								}, 300 )
							})
						
						} else {
							
							log.warn( `learn-structure: ${model} is no longer available and no fallback left` )
							
							throw new Error( msg )
						
						}
					}
						
					if( isTransientError( msg ) && modelIndex + 1 < modelsToTry.length ) {
						
						// note(dgmid): transient error — try the fallback model
						
						return new Promise( resolve => {
							setTimeout( () => {
								tryModels( modelIndex + 1 ).then( resolve )
							}, 1000 )
						})
					}
					
					throw new Error( msg )
			}
			
			//note(dgmid): a successful call — parse the reply text (provider-agnostic)
			return parseLearnResponse( response.data )
		}).then( result => {
			
			analyzing = false
			
			if( result ) {
				showResults( result )
			} else {
				showAnalyzeError()
			}
		}).catch( error => {
			
			analyzing = false
			log.error( `learn-structure: ${error.message}` )
			showAnalyzeError()
		})
	}
}



//note(dgmid): show the detected criterion for review / editing

function showResults( result ) {
	
	$('#step-progress').hide()
	$('#step-results').show()
	
	detectedFolderNames = result.folderNames || []
	
	if( !result.name && !result.description ) {
		
		$('#no-criterion').text(
			i18n.t('learn:results.nocriterion', 'No clear criterion was detected in this structure. You can still describe one yourself and save it, or close.')
		).show()
		
	} else {
		
		$('#no-criterion').hide()
	}
	
	$('#profile-name').val( result.name || '' )
	$('#profile-description').val( result.description || '' )
	
	let folderList = ( detectedFolderNames.length > 0 )
		? detectedFolderNames.map( n => '📁 ' + n ).join('\n')
		: i18n.t('learn:results.nofoldernames', '(none detected)')
	
	$('#folder-names').text( folderList )
	
	renderTagList()
	
	$('#btn-save').show()
	$('#btn-close').text( i18n.t('learn:button.close', 'Close') )
}



//note(dgmid): restore the start step after an analysis failure

function showAnalyzeError() {
	
	$('#step-progress').hide()
	$('#step-start').show()
	$('#btn-start').show()
	$('#btn-close').text( i18n.t('learn:button.close', 'Close') )
	
	$('#cfg-errors').html(
		i18n.t('learn:error.analysis', 'The analysis failed. Please try again.')
	).show()
}



//note(dgmid): render the tag vocabulary as editable checkboxes (checked = include in profile)

function renderTagList() {
	
	let $list = $('#tag-list').empty()
	
	if( !detectedTags || detectedTags.length === 0 ) {
		
		$list.html( '<div style="font-size:11px;opacity:.6;">' + i18n.t('learn:results.notags', 'No tags found in this folder\'s bookmarks — this profile will only guide folder names.') + '</div>' )
		return
	}
	
	for( let i = 0; i < detectedTags.length; i++ ) {
		
		let t = detectedTags[i]
		
		let ex = ( t.examples || [] ).slice( 0, 2 ).map( s => '"' + cleanExample( s ).substring( 0, 50 ) + '"' ).join( ', ' )
		
		let $label = $('<label>', {
			style: 'display:flex !important;align-items:center;gap:6px;cursor:pointer;margin-bottom:4px;'
		})
		
		$label.append( $('<input>', { type: 'checkbox', checked: true, style: 'margin:0;flex:none;' }).attr( 'data-index', i ) )
		$label.append( $('<span>', { style: 'font-weight:600;', text: t.tag }) )
		$label.append( $('<span>', { style: 'font-weight:400;opacity:.7;font-size:11px;', text: ' ×' + t.count + ( ex ? ' — ' + ex : '' ) }) )
		
		$list.append( $label )
	}
}



//note(dgmid): save the profile to the store (aiProfiles)

$('#btn-save').click( function() {
	
	let name 		= $('#profile-name').val().trim(),
		description = $('#profile-description').val().trim()
	
	if( !name ) {
		
		ipcRenderer.send('show-error-box', {
			title: i18n.t('learn:error.noname_title', 'Profile Name Required'),
			content: i18n.t('learn:error.noname_content', 'Please enter a name for the profile.')
		})
		return
	}
	
	//note(dgmid): gather the tags the user kept checked
	let selectedTags = []
	
	$('#tag-list input[type="checkbox"]').each( function() {
		
		let idx = parseInt( $(this).attr( 'data-index' ), 10 )
		
		if( $(this).prop( 'checked' ) && detectedTags[idx] ) {
			
			selectedTags.push( detectedTags[idx] )
		}
	})
	
	let profiles = store.get( 'aiProfiles' ) || []
	
	//note(dgmid): reject case-insensitive duplicate profile names so the dropdowns
	//in Auto-Tag / Auto-Organize stay unambiguous
	let duplicate = profiles.find( p => String( p.name || '' ).trim().toLowerCase() === name.toLowerCase() )
	
	if( duplicate ) {
		
		ipcRenderer.send('show-error-box', {
			title: i18n.t('learn:error.duplicate_title', 'Profile Already Exists'),
			content: i18n.t('learn:error.duplicate_content', 'A profile named "{{name}}" already exists. Choose a different name.', { name: duplicate.name })
		})
		return
	}
	
	profiles.push({
		id: 'p' + Date.now(),
		name: name,
		description: description,
		folderNames: detectedFolderNames,
		tagExamples: selectedTags,
		sourceFolder: ( context && context.folderName ) ? context.folderName : 'Home',
		createdAt: Date.now()
	})
	
	store.set( 'aiProfiles', profiles )
	
	let $btn = $(this)
	$btn.prop('disabled', true).text( '✓ ' + i18n.t('learn:button.saved', 'Profile Saved') )
	
	setTimeout( () => {
		ipcRenderer.send( 'close-current-window' )
	}, 900 )
})



//note(dgmid): analyze button

$('#btn-start').click( function() {
	
	if( analyzing ) return
	
	analyzeStructure()
})



//note(dgmid): close / cancel button

$('#btn-close').click( function() {
	
	ipcRenderer.send( 'close-current-window' )
})
