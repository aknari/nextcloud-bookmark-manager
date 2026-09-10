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
const defaultProfile = require( './ai-default-profile.min' )
const aiClient = require( './ai-client.min' )

jqueryI18next.init(i18n, $)

//note(dgmid): make sure the built-in Default profile is always present

defaultProfile.ensureDefaultProfile( store )



//note(dgmid): log exceptions

window.onerror = function( error, url, line ) {
	
	ipcRenderer.send( 'error-in-render', {error, url, line} )
}



//note(dgmid): set lang & localize strings

$('html').attr('lang', i18n.language)
$('header').localize()
$('.section-title').localize()
$('.hint').localize()
$('label').localize()
$('button').localize()



//note(dgmid): state

let results = [],
	processing = false,
	cancelled = false,
	quotaBlocked = false,	// true once the API quota stops the run (daily limit or retries exhausted)
	quotaTimer = null,		// live countdown timer for the per-minute quota banner
	quotaDeadModels = {},	// models whose quota ran out this session — skipped on later batches
	sessionTotal = 0		// bookmarks this run was asked to process (for the summary)

//note(dgmid): scope state — mirrors the auto-organize modal. mode is 'selection' when
//bookmarks are selected (act on exactly those), 'folder' when the current folder is used
//(with an optional recursive scope), 'none' when there is nothing to process.

let context 			= null,		// { folderId, folderName, bookmarks: [{id,title,url,folders}] } passed by main window
	mode 				= 'none',	// 'selection' | 'folder' | 'none'
	workingBookmarks 	= [],		// the effective bookmark set (selection, or folder direct/recursive)
	sessionCap 			= 100		// effective AI session cap (config value, possibly overridden for this run)



//note(dgmid): sanitize example titles for the prompt/UI — strip double quotes,
//newlines and excess whitespace so they can't break the quoted examples or markup

function cleanExample( s ) {
	
	return String( s || '' ).replace( /["\\]/g, '' ).replace( /[\r\n\t]+/g, ' ' ).replace( /\s{2,}/g, ' ' ).trim()
}



//note(dgmid): fallback models to try when the primary model is overloaded
// Ordered by likelihood of availability (lite models handle more traffic)

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



//note(dgmid): load config and check selection

function loadConfig() {
	
	let config = store.get( 'aiConfig' ) || {}
	
	let problem = aiClient.configProblem( aiClient.normalizeConfig( config ) )
	
	if( problem ) {
		
		$('#cfg-errors').html(
			i18n.t( 'autotag:error.' + problem.code, problem.message )
		).show()
		
		$('#btn-start').prop('disabled', true)
		return null
	}
	
	$('#cfg-model').text( resolvePrimaryModel( config.model ) )
	$('#cfg-maxtags').text( config.maxTags || 8 )
	$('#cfg-maxsession').text( config.maxPerSession || 100 )
	
	populateProfileSelect()
	renderProfilePreview()
	
	//note(dgmid): determine the scope. Selected bookmarks take priority (selection mode);
	//otherwise the current folder context is used (folder mode), mirroring auto-organize.
	context = store.get( '_autoTagContext' ) || null
	
	let selection = store.get( '_autoTagSelection' ) || []
	
	if( selection.length > 0 ) {
		
		mode = 'selection'
		workingBookmarks = selection
		
		$('#selection-scope').show()
		$('.folder-scope').hide()
		
		$('#cfg-selectedbm').text(
			i18n.t('autotag:label.selected_count', '{{selected}} bookmarks selected', {selected: selection.length})
		)
		
	} else if( context && context.bookmarks && context.bookmarks.length > 0 ) {
		
		mode = 'folder'
		
		$('#selection-scope').hide()
		$('.folder-scope').show()
		
		$('#cfg-folder').text( context.folderName || 'Home' )
		
	} else {
		
		mode = 'none'
		workingBookmarks = []
		
		$('#selection-scope').show()
		$('.folder-scope').hide()
		
		$('#cfg-selectedbm').html(
			'<span style="color:#856404;">' +
			i18n.t('autotag:label.none_selected', 'None selected — select bookmarks (Ctrl+Click) or a folder first') +
			'</span>'
		)
	}
	
	//note(dgmid): recompute the working set + session-cap notice for the current mode
	refreshCount()
	
	return config
}

loadConfig()



//note(dgmid): ids of every folder under parentId (recursive) — used by the
//"include bookmarks in subfolders" option in folder mode

function getDescendantIds( folders, parentId ) {
	
	let result 	= [],
		queue 	= [ parentId ]
	
	while( queue.length ) {
		
		let pid = queue.shift()
		
		for( let f of folders ) {
			
			let parent = ( f.parent_folder == null || f.parent_folder === -1 || f.parent_folder === '-1' ) ? -1 : f.parent_folder
			
			if( parent === pid && !result.includes( f.id ) ) {
				
				result.push( f.id )
				queue.push( f.id )
			}
		}
	}
	
	return result
}



//note(dgmid): recompute the working bookmark set (selection, or folder direct/recursive)
//and the session-cap notice whenever the scope options change. Selection mode is static
//(exactly the selected bookmarks); folder mode filters by the include-subfolders option.

function refreshCount() {
	
	if( mode === 'folder' ) {
		
		let recursive 	= $( '#chk-include-subfolders' ).is( ':checked' ),
			allBookmarks = ( context && context.bookmarks ) ? context.bookmarks : [],
			fid 		= ( context && context.folderId != null ) ? context.folderId : -1,
			folders 	= store.get( 'folders' ) || []
		
		if( recursive ) {
			
			let ids = new Set( getDescendantIds( folders, fid ) )
			
			ids.add( fid )
			
			workingBookmarks = allBookmarks.filter( b => ( b.folders || [] ).some( f => ids.has( f ) ) )
			
		} else {
			
			workingBookmarks = allBookmarks.filter( b => ( b.folders || [] ).includes( fid ) )
		}
		
		$('#cfg-count').text( workingBookmarks.length )
	}
	
	//note(dgmid): effective session cap (config value, possibly overridden for this run)
	let maxSession = ( store.get( 'aiConfig' ) || {} ).maxPerSession || 100
	sessionCap = maxSession
	
	if( workingBookmarks.length === 0 ) {
		
		if( mode === 'folder' ) {
			
			$('#cfg-count').html(
				'<span style="color:#856404;">' +
				i18n.t('autotag:label.nofolder', 'No bookmarks found in this folder — select bookmarks or a folder first') +
				'</span>'
			)
		}
		
		$('#btn-start').prop('disabled', true)
		$('#cap-notice').hide()
		return
	}
	
	$('#btn-start').prop('disabled', false)
	
	if( workingBookmarks.length > maxSession ) {
		
		$('#cap-text').html(
			i18n.t('autotag:label.capnotice', 'This run will process only <strong>{{cap}}</strong> of <strong>{{total}}</strong> bookmarks (AI session cap).', {
				cap: maxSession,
				total: workingBookmarks.length
			})
		)
		$('#chk-override-cap').prop( 'checked', false )
		$('#cap-notice').show()
		
	} else {
		
		$('#cap-notice').hide()
	}
}



//note(dgmid): shared "consider existing tags" toggle — applies to both Auto-Tag
//and Auto-Organize. Persisted so the choice carries across modals and sessions.

$('#chk-consider-existing').prop( 'checked', store.get( 'aiConsiderExisting' ) !== false )

$('#chk-consider-existing').on( 'change', function() {
	
	store.set( 'aiConsiderExisting', $(this).is( ':checked' ) )
})



//note(dgmid): folder mode — toggling include-subfolders recomputes the working set

$('#chk-include-subfolders').on( 'change', function() {
	
	refreshCount()
})



//note(dgmid): overriding the session cap applies only to this run (not saved)

$('#chk-override-cap').on( 'change', function() {
	
	sessionCap = $(this).is( ':checked' )
		? workingBookmarks.length
		: ( ( store.get( 'aiConfig' ) || {} ).maxPerSession || 100 )
})



//note(dgmid): populate the optional tagging profile selector from the learned profiles store

function populateProfileSelect() {
	
	//note(dgmid): the built-in Default profile is always first (never deletable)
	let profiles = defaultProfile.ensureDefaultProfile( store )
	
	let $select = $('#profile-select')
	$select.empty()
	
	for( let p of profiles ) {
		
		let label = defaultProfile.isBuiltin( p )
			? i18n.t('autotag:label.defaultprofile', 'Default (built-in)')
			: p.name + ( ( p.tagExamples && p.tagExamples.length > 0 ) ? '' : i18n.t('autotag:label.notagsuffix', ' (no tags)') )
		
		$select.append( $( '<option>', {
			value: p.id,
			text: label
		}))
	}
	
	//note(dgmid): pre-select the Default profile
	if( $select.find( 'option' ).length > 0 && !$select.val() ) {
		$select.val( 'default' )
	}
}



//note(dgmid): render the selected profile's learned tag vocabulary as an informative
//preview (tag + count + one example title each) so the user knows what the AI will prefer.

function renderProfilePreview() {
	
	let $pv 	= $('#profile-preview'),
		profileId 	= $('#profile-select').val()
	
	if( !profileId ) {
		
		$pv.hide()
		return
	}
	
	let profile = ( store.get( 'aiProfiles' ) || [] ).find( p => String( p.id ) === String( profileId ) )
	
	if( !profile || !profile.tagExamples || profile.tagExamples.length === 0 ) {
		
		$pv.html( '<div class="pv-none">' + i18n.t('autotag:label.profilepreview_none', '(no tags in this profile)') + '</div>' ).show()
		return
	}
	
	let html = profile.tagExamples.slice( 0, 20 ).map( t => {
		
		let ex = ( t.examples || [] ).slice( 0, 1 ).map( s => `<span class="pv-ex">"${cleanExample( s ).substring( 0, 40 )}"</span>` ).join('')
		
		return `<div class="pv-tag">• ${t.tag}<span class="pv-count">×${t.count}</span>${ex}</div>`
	}).join('')
	
	$pv.html( html ).show()
}



//note(dgmid): show status in progress bar

function setProgress( current, total, label ) {
	
	let pct = total > 0 ? Math.round( current / total * 100 ) : 0
	
	$('#progress-fill').css( 'width', pct + '%' )
	$('#progress-text').text( label || `${current} / ${total}` )
}



//note(dgmid): check if a Gemini error is a transient server issue (high demand, rate limit, etc.)
//              These should trigger a retry with a fallback model instead of giving up.

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



//note(dgmid): is this a QUOTA / rate-limit error? The free tier caps each model
//separately (e.g. ~20 requests/minute), so if ONE model is out of quota the run
//falls back to the next model — only when EVERY model is blocked does it stop.

function isQuotaError( message ) {
	
	let m = (message || '').toLowerCase()
	
	return m.includes( 'quota' ) ||
	       m.includes( 'rate limit' ) ||
	       m.includes( 'resource exhausted' ) ||
	       m.includes( '429' )
}



//note(dgmid): extract the suggested wait from a quota error ("Please retry in 57.5s")

function parseQuotaWait( message ) {
	
	let m 	= String( message || '' ),
		mm 	= m.match( /retry in\s+([\d.]+)\s*s/i )
	
	if( mm ) {
		
		let s = parseFloat( mm[1] )
		
		if( s > 0 && s <= 600 ) return Math.max( 5, Math.ceil( s ) )
	}
	
	return 60
}



//note(dgmid): does the quota error carry a "retry in Xs" hint? The per-minute limit
//does; the DAILY limit does not (it resets at midnight Pacific Time instead, so
//waiting 60s repeatedly is pointless).

function hasRetryHint( message ) {
	
	return /retry in\s+[\d.]+\s*s/i.test( String( message || '' ) )
}



//note(dgmid): some quota responses spell out the DAILY nature of the limit right in
//the message (e.g. "...per day...", quotaId ...PerDay...). When present, waiting a
//minute is pointless — only the midnight-Pacific reset helps, so stop immediately.

function isDailyQuota( message ) {
	
	let m = String( message || '' ).toLowerCase()
	
	return m.includes( 'per day' ) ||
	       m.includes( 'perday' ) ||
	       m.includes( 'per_day' ) ||
	       m.includes( 'daily limit' ) ||
	       m.includes( 'daily request quota' ) ||
	       m.includes( 'perdayperproject' )
}



//note(dgmid): how long until midnight in the Pacific timezone (Gemini's free daily
//quota resets there). Falls back to a conservative ~12h estimate if Intl is missing.

function pacificMidnightETA() {
	
	try {
		
		let now 	= new Date(),
			fmt 	= new Intl.DateTimeFormat( 'en-US', {
				timeZone: 'America/Los_Angeles',
				hour: 'numeric',
				minute: 'numeric',
				hour12: false
			}),
			parts 	= fmt.formatToParts( now )
		
		let hour 	= parseInt( parts.find( p => p.type === 'hour' ).value, 10 ) % 24,
			minute 	= parseInt( parts.find( p => p.type === 'minute' ).value, 10 ) || 0
		
		let totalMinutes 	= hour * 60 + minute,
			untilMidnight 	= ( 1440 - totalMinutes ) % 1440
		
		return {
			hours: Math.floor( untilMidnight / 60 ),
			minutes: untilMidnight % 60
		}
		
	} catch( e ) {
		
		return { hours: 12, minutes: 0 }
	}
}



//note(dgmid): show / hide the visible quota banner in the modal. Three states:
//'minute'  — per-minute limit, automatic retry in progress (wait, attempt)
//'daily'   — detected daily limit on first hit (no "retry in" hint): resets at midnight Pacific
//'stopped' — retries exhausted but still blocked: the per-minute window (3×~60s) has
//            long refreshed, so this is almost certainly the daily limit — same reset info.
//Both 'daily' and 'stopped' tell the user when the quota resets so they can leave safely.

function showQuotaNotice( kind, wait, attempt ) {
	
	let $q = $('#quota-notice')
	
	if( !$q.length ) return
	
	stopQuotaCountdown()
	
	let eta = pacificMidnightETA()
	
	if( kind === 'daily' ) {
		
		$('#quota-title').text( i18n.t( 'autotag:progress.quota_daily_title', 'Daily API quota reached' ) )
		$('#quota-body').html(
			i18n.t( 'autotag:progress.quota_daily', 'The free daily quota has been exhausted. It resets at midnight Pacific Time (in about <strong>{{hours}}h {{minutes}}m</strong>). You can close this window with peace of mind — nothing has been changed and no bookmarks have been lost.', {
				hours: eta.hours,
				minutes: eta.minutes
			})
		)
		
	} else if( kind === 'stopped' ) {
		
		$('#quota-title').text( i18n.t( 'autotag:progress.quota_stopped_title', 'Run stopped — API quota exhausted' ) )
		$('#quota-body').html(
			i18n.t( 'autotag:progress.quota_stopped', 'The run was stopped because the API quota is still exhausted after several retries. This is very likely the daily limit — it resets at midnight Pacific Time (in about <strong>{{hours}}h {{minutes}}m</strong>). You can close this window with peace of mind — nothing has been changed and no bookmarks have been lost.', {
				hours: eta.hours,
				minutes: eta.minutes
			})
		)
		
	} else {
		
		$('#quota-title').text( i18n.t( 'autotag:progress.quota_minute_title', 'API quota reached — retrying automatically' ) )
		$('#quota-body').html(
			i18n.t( 'autotag:progress.quota_minute', 'The per-minute API limit was reached. Retrying in <strong>{{wait}}s</strong> (attempt {{attempt}} of {{max}}). You can leave this window open — it will continue on its own.', {
				wait: wait,
				attempt: attempt,
				max: MAX_QUOTA_WAITS
			})
		)
		
		//note(dgmid): live countdown so the wait number ticks down instead of staying frozen
		startQuotaCountdown( wait )
	}
	
	$q.show()
}



function hideQuotaNotice() {
	
	stopQuotaCountdown()
	
	$('#quota-notice').hide()
}



//note(dgmid): live countdown for the per-minute quota banner — the wait number ticks
//down every second and stops when it reaches zero or the banner is hidden

function startQuotaCountdown( seconds ) {
	
	stopQuotaCountdown()
	
	let remaining 	= ( Number.isFinite( seconds ) ? Math.max( 0, Math.round( seconds ) ) : 0 ),
		$secs 		= $('#quota-body strong').first()
	
	if( !$secs.length ) return
	
	$secs.text( remaining + 's' )
	
	quotaTimer = setInterval( () => {
		
		remaining--
		
		if( remaining <= 0 ) {
			
			stopQuotaCountdown()
			$secs.text( '0s' )
			return
		}
		
		$secs.text( remaining + 's' )
	}, 1000 )
}

function stopQuotaCountdown() {
	
	if( quotaTimer ) {
		
		clearInterval( quotaTimer )
		quotaTimer = null
	}
}



//note(dgmid): minimum gap between AI calls — the free Gemini tier allows ~20
//requests/minute. Configurable via aiConfig.apiGapMs (0 disables pacing).

let lastApiCallAt = 0

function getApiGapMs() {
	
	let g = ( store.get( 'aiConfig' ) || {} ).apiGapMs
	
	return ( typeof g === 'number' && g >= 0 ) ? g : 3500
}



//note(dgmid): how many times a single call may wait out a quota error before giving up.
//One full wait+retry is enough: a ~60s wait refreshes the per-minute window, so a quota
//error that survives it is the DAILY limit (resets at midnight Pacific) — further 60s
//waits would only waste minutes before the same conclusion.

const MAX_QUOTA_WAITS = 1



//note(dgmid): check if a string looks like a meaningful tag (not punctuation, not truncated)

function isValidTag( tag ) {
	
	// Must have at least 2 characters
	if( tag.length < 2 ) return false
	
	// Must contain at least one letter or digit (rejects pure punctuation like "*", "-")
	if( !/[a-zA-Z0-9]/.test( tag ) ) return false
	
	// Reject purely numeric tags (product IDs, order numbers like "31063927")
	if( /^\d+$/.test( tag ) ) return false
	
	// Reject numbered list artifacts ("2.", "1)", etc.)
	if( /^\d+[\.\)]/.test( tag ) ) return false	// Reject tags that start or end with a hyphen or underscore (likely truncated, e.g. "circuit-")
	if( /^[-_]/.test( tag ) || /[-_]$/.test( tag ) ) return false

	// Reject URL parameter artifacts ("tracelog=ro", "spm=a2g0o")
	if( tag.includes( '=' ) || tag.includes( '&' ) || tag.includes( '%' ) ) return false

	// Must not be just a common filler word
	if( [ 'the', 'and', 'for', 'its', 'not', 'but', 'are', 'was', 'had', 'has', 'all', 'can', 'get', 'new', 'how', 'why', 'top', 'big' ].includes( tag ) ) return false
	
	return true
}



//note(dgmid): extract tags from a markdown-style list (lines starting with - or *)

function extractMarkdownListItems( text ) {
	
	let items = []
	let lines = text.split( '\n' )
	
	for( let line of lines ) {
		
		let match = line.match( /^\s*[-*]\s+(.+)/ )
		
		if( match ) {
			
			let item = match[1].trim().toLowerCase().replace( /^["']|["']$/g, '' )
			
			if( item.length > 0 ) {
				items.push( item )
			}
		}
	}
	
	return items
}



//note(dgmid): filter a raw tags array to remove garbage

function filterValidTags( rawTags, maxTags ) {
	
	let cleaned = rawTags.map( t => {
		// Strip surrounding quotes, trim, lowercase
		return String(t).trim().toLowerCase().replace( /^["']|["']$/g, '' )
	}).filter( t => t.length > 0 && !t.startsWith('{') && !t.startsWith('[') )
	
	// Apply validity check
	cleaned = cleaned.filter( isValidTag )
	
	// Remove duplicates and limit
	return [ ...new Set( cleaned ) ].slice( 0, maxTags )
}



//note(dgmid): parse Gemini API response into cleaned tags

function parseGeminiResponse( data, maxTags ) {
	
	let text = aiClient.extractTextAny( data )
	
	if( !text ) {
		
		log.warn( `auto-tag: AI returned empty response` )
		return []
	}
	
	let trimmed = text.trim()
	let jsonStr = trimmed
	
	// Handle markdown code blocks (```json ... ```)
	let codeBlockMatch = trimmed.match( /```(?:json)?\s*([\s\S]*?)```/ )
	
	if( codeBlockMatch ) {
		
		jsonStr = codeBlockMatch[1].trim()
	}
	
	// Try #1: Parse as JSON
	let tags = []
	
	try {
		let parsed = JSON.parse( jsonStr )
		
		if( Array.isArray( parsed ) ) {
			
			tags = filterValidTags( parsed, maxTags )
			
		} else if( typeof parsed === 'object' && parsed.tags ) {
			
			tags = filterValidTags( parsed.tags, maxTags )
		}
		
		if( tags.length > 0 ) {
			
			return tags
		}
	}
	catch( e ) {
		
		// note(dgmid): JSON parse failed — fall through to the fallback parsers below
	}
	
	// Try #2: Markdown list (lines starting with - or *)
	let mdItems = extractMarkdownListItems( jsonStr )
	
	if( mdItems.length > 0 ) {
		
		tags = filterValidTags( mdItems, maxTags )
		
		if( tags.length > 0 ) {
			
			return tags
		}
	}
	
	// Try #3: Comma/line-separated list
	let rawParts = jsonStr.split( /[,\n]+/ )
	tags = filterValidTags( rawParts, maxTags )
	
	return tags
}



//note(dgmid): strip tracking parameters from URLs to avoid confusing Gemini with long AliExpress/Amazon URLs

function cleanUrl( urlString ) {
	
	try {
		let u = new URL( urlString )
		
		// Keep only protocol + hostname + pathname (strip all query params and hash)
		let cleaned = u.protocol + '//' + u.hostname + u.pathname
		
		// Remove trailing slash for consistency
		if( cleaned.endsWith( '/' ) && cleaned.length > 10 ) {
			cleaned = cleaned.slice( 0, -1 )
		}
		
		return cleaned
		
	} catch( e ) {
		
		// If URL parsing fails, return the original
		return urlString
	}
}



//note(dgmid): provider-aware POST for one bookmark — builds the request for the
//configured provider (gemini / openrouter / local) and resolves { ok, status, data }
//with the raw JSON, so the quota / model-unavailable branches below stay identical

function aiPost( model, prompt ) {
	
	let cfg = aiClient.normalizeConfig( store.get( 'aiConfig' ) || {} )
	cfg.model = model || cfg.model
	
	let req = aiClient.buildChatRequest( cfg, prompt, 300, { json: false } )
	
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



//note(dgmid): call the configured AI provider for a single bookmark, with automatic model fallback

function tagBookmark( title, url, apiKey, primaryModel, maxTags, profile, existingVocab ) {
	
	// Sanitize title for the prompt — "None" or empty titles confuse Gemini
	let safeTitle = ( title && title !== 'None' && title !== 'none' ) ? title : '(untitled)'
	
	// Clean URL: strip tracking parameters to avoid confusing Gemini
	let safeUrl = cleanUrl( url || '' )
	
	//note(dgmid): soft preference — bias the output toward the user's learned vocabulary
	let vocabBlock = ''
	
	if( profile && profile.tagExamples && profile.tagExamples.length > 0 ) {
		
		let vocab = profile.tagExamples.slice( 0, 25 ).map( t => {
			
		let ex = ( t.examples || [] ).slice( 0, 2 ).map( s => `"${cleanExample( s ).substring( 0, 60 )}"` ).join( ', ' )
		
		return `- ${t.tag}${ex ? ' (e.g. ' + ex + ')' : ''}`
		}).join( '\n' )
		
		vocabBlock = `\nThe user's personal tag vocabulary (with example titles):\n${vocab}\nPrefer these tags when they fit. You may add new tags if none of them fit, but keep the same style.\n`
	}
	
	//note(dgmid): existing tags from the user's own catalog (when the shared
	//"consider existing tags" option is on) — reuse them before inventing new ones
	let existingBlock = ''
	
	if( existingVocab && existingVocab.length > 0 ) {
		
		let lines = existingVocab.slice( 0, 30 ).map( t => `- ${t.tag}` ).join( '\n' )
		
		existingBlock = `\nThe user already uses these tags (reuse them when they fit, keep the same style):\n${lines}\n`
	}
	
	// Build a list of models to try: primary first, then fallbacks not matching primary
	let modelsToTry = buildModelsToTry( primaryModel )
	
	// Returns a promise that resolves with tags (or empty array on total failure)
	return tryModels( 0, 0 )
	
	
	function tryModels( modelIndex, quotaWaits ) {
		
		if( modelIndex >= modelsToTry.length ) {
			
			if( !quotaBlocked && Object.keys( quotaDeadModels ).length >= modelsToTry.length ) {
				
				quotaBlocked = true
				
				showQuotaNotice( 'daily', 0, 0 )
				
				log.warn( `auto-tag: all ${modelsToTry.length} models quota-blocked — stopping run` )
			}
			
			// All models failed — return empty tags
			log.warn( `auto-tag: all ${modelsToTry.length} models failed for "${safeTitle.substring(0, 50)}"` )
			return Promise.resolve( [] )
		}
		
		//note(dgmid): skip models already known to be quota-blocked this session
		if( quotaDeadModels[ modelsToTry[ modelIndex ] ] || unavailableModels[ modelsToTry[ modelIndex ] ] ) {
			
			return tryModels( modelIndex + 1, quotaWaits )
		}
		
		let model = modelsToTry[modelIndex]
		
		let prompt = `You are a precise bookmark tagging assistant. Your ONLY task is to output a JSON array of tags.

STRICT RULES:
- Output EXACTLY: ["tag1", "tag2", "tag3"]
- NO other text, NO markdown, NO code blocks, NO bullet points, NO explanations
- Keep tags SIMPLE and short: prefer single, everyday words (e.g. "programming", "music", "shopping")
- Mix a few SPECIFIC tags with ONE broader generic tag when the topic is clear (e.g. for a React tutorial: "react", "javascript", "webdev")
- For compound concepts use a HYPHEN (e.g. "comp-arch", "data-science", "ulpgc-notes") — never spaces, slashes, camelCase or underscores
- Match the language of the bookmark: Spanish titles get Spanish tags (unless the vocabulary below suggests otherwise)
- Maximum ${maxTags} tags
- If unsure about relevance, include fewer tags rather than poor ones
${vocabBlock}${existingBlock}
Bookmark title: ${safeTitle}
Bookmark URL: ${safeUrl}`

		//note(dgmid): pace the call so a run stays under the free-tier request limit
		let gap = getApiGapMs() - ( Date.now() - lastApiCallAt )
		if( gap < 0 ) gap = 0
		
		return new Promise( resolve => {
			
			setTimeout( () => {
				
				lastApiCallAt = Date.now()
				
				aiPost( model, prompt ).then( response => {
					
					if( !response.ok ) {
						
						let data = response.data
						
						let msg = aiClient.extractErrorAny( response.status, data )
							
							//note(dgmid): QUOTA — distinguish the per-minute limit (has a "retry in Xs"
							//hint, waiting works) from the DAILY limit (no hint — resets at midnight
							//Pacific, waiting 60s repeatedly is pointless). All free models share the
							//same pool, so switching models never helps with a quota error.
							if( isQuotaError( msg ) ) {
								
								//note(dgmid): a "retry in Ns" hint with N in the thousands is the
								//DAILY limit (resets at midnight Pacific) — don't burn a 60s wait
								let retrySecs = parseFloat( ( String( msg ).match( /retry in\s+([\d.]+)\s*s/i ) || [] )[1] || 0 )
								
								let daily = !hasRetryHint( msg ) || isDailyQuota( msg ) || retrySecs > 600
								
								if( daily || quotaWaits >= MAX_QUOTA_WAITS ) {
									
									//note(dgmid): THIS model's quota is exhausted — remember it and
									//move to the next model. Free-tier quotas are PER MODEL, so a
									//single blocked model must not stop the whole run.
									quotaDeadModels[ model ] = true
									
									log.warn( `auto-tag: API quota ${daily ? 'DAILY limit' : 'still active after a full retry wait'} (${model})` )
									
									let next = modelIndex + 1
									while( next < modelsToTry.length && quotaDeadModels[ modelsToTry[ next ] ] ) next++
									
									if( next < modelsToTry.length ) {
										
											log.warn( `auto-tag: ${model} quota-blocked — falling back to ${modelsToTry[next]}` )
											
											resolve( new Promise( resolve2 => {
												setTimeout( () => tryModels( next, 0 ).then( resolve2 ), 1000 )
											}) )
											return
										}
										
										//note(dgmid): every model is now blocked — stop the run; the
										//visible banner tells the user when the quota resets.
										quotaBlocked = true
										
										showQuotaNotice( daily ? 'daily' : 'stopped', 0, 0 )
										
										log.warn( `auto-tag: API quota blocked on all models (${model}) — stopping run` )
										
										resolve( [] )
										return
									}
								
								let wait = parseQuotaWait( msg )
								
								showQuotaNotice( 'minute', wait, quotaWaits + 1 )
								
								log.warn( `auto-tag: API quota reached (${model}) — waiting ${wait}s before retrying (${quotaWaits + 1}/${MAX_QUOTA_WAITS})` )
								
								$('#progress-text').text(
									i18n.t('autotag:progress.quota', 'API quota reached — retrying in {{wait}}s…', { wait: wait })
								)
								
								resolve( new Promise( resolve2 => {
									setTimeout( () => {
										tryModels( modelIndex, quotaWaits + 1 ).then( resolve2 )
									}, wait * 1000 )
								}) )
								return
							}
							
							if( isModelUnavailable( msg ) ) {
								
								unavailableModels[ model ] = true
								
								if( modelIndex + 1 < modelsToTry.length ) {
									
									log.warn( `auto-tag: ${model} is no longer available - falling back to ${modelsToTry[ modelIndex + 1 ]}` )
									
									resolve( new Promise( resolve2 => {
										setTimeout( () => {
											tryModels( modelIndex + 1, quotaWaits ).then( resolve2 )
										}, 300 )
									}) )
								
								} else {
									
									log.warn( `auto-tag: ${model} is no longer available and no fallback left - returning no tags` )
									
									resolve( [] )
								
								}
								
								return
							}
								
							if( isTransientError( msg ) && modelIndex + 1 < modelsToTry.length ) {
								
								// note(dgmid): transient error — wait a bit before trying the fallback model
								resolve( new Promise( resolve2 => {
									setTimeout( () => {
										tryModels( modelIndex + 1, quotaWaits ).then( resolve2 )
									}, 1000 )
								}) )
								return
							}
							
							resolve( Promise.reject( new Error( msg ) ) )
							return
					}					//note(dgmid): a successful call means the wait is over — hide the banner
				hideQuotaNotice()
				
				resolve( parseGeminiResponse( response.data, maxTags ) )
					
				}).catch( error => {
					
					resolve( Promise.reject( error ) )
				})
			}, gap )
		})
	}
}



//note(dgmid): clear all tags for a bookmark via the API
//              Uses direct fetch to send PUT with empty tags array

function clearAllTags( bookmarkId ) {
	
	let server 	= store.get( 'loginCredentials.server' ),
		username = store.get( 'loginCredentials.username' ),
		password = store.get( 'loginCredentials.password' )
	
	let url = `${server}/index.php/apps/bookmarks/public/rest/v2/bookmark/${bookmarkId}`
	
	// Promise.race with 10s timeout to avoid hanging the processing queue
	return Promise.race([
		
		fetch( url, {
			method: 'PUT',
			headers: {
				'Authorization': 'Basic ' + btoa( username + ':' + password ),
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ tags: [] })
		}).then( response => {
			
			if( !response.ok ) {
				log.warn( `clear-tags failed for bookmark ${bookmarkId}: HTTP ${response.status}` )
				return false
			}
			
			return true
		}),
		
		new Promise( ( _, reject ) => {
			setTimeout( () => reject( new Error( 'timeout' ) ), 10000 )
		})
		
	]).catch( err => {
		
		log.error( `clear-tags error for bookmark ${bookmarkId}: ${err.message}` )
		return false
	})
}



//note(dgmid): process all bookmarks

function processBookmarks() {
	
	processing = true
	cancelled = false
	
	//note(dgmid): a new run invalidates the previous run/apply status markers
	$('#btn-apply').removeClass( 'done' )
	setActionStatus( '' )
	quotaBlocked = false
	quotaDeadModels = {}
	unavailableModels = {}
	results = []
	
	hideQuotaNotice()
	
	let config = store.get( 'aiConfig' ) || {}
	let apiKey = config.apiKey,
		primaryModel = resolvePrimaryModel( config.model ),
		maxTags = config.maxTags || 8
	
	let profileId 	= $( '#profile-select' ).val(),
		profile 	= ( store.get( 'aiProfiles' ) || [] ).find( p => String( p.id ) === String( profileId ) ) || null,
		shouldClear 	= $( '#chk-clear-tags' ).is( ':checked' ),
		considerExisting = $( '#chk-consider-existing' ).is( ':checked' ),
		existingVocab 	= considerExisting ? ( store.get( '_autoTagVocabulary' ) || [] ) : []
	
	// Show progress step
	$('#step-start').hide()
	$('#step-progress').show()
	$('#btn-start').hide()
	$('#btn-close').text( i18n.t('autotag:button.cancel', 'Cancel') )
	
	//note(dgmid): the working set was computed by refreshCount() (selection mode → the
	//selected bookmarks; folder mode → the direct/recursive folder scope). Respect the
	//effective session cap (config value or temporary override).
	let selectedData = workingBookmarks
	
	if( selectedData.length === 0 ) {
		
		setProgress( 0, 1, i18n.t('autotag:error.noselected', 'No bookmarks to process. Select bookmarks first (Ctrl+Click or Shift+Click).') )
		processing = false
		$('#btn-close').text( i18n.t('autotag:button.close', 'Close') )
		return
	}
	
	// Respect the session cap (config value, or the temporary override)
	let toProcess = selectedData.slice( 0, sessionCap )
	let total = toProcess.length
	sessionTotal = total
	
	setProgress( 0, total, i18n.t('autotag:progress.starting', 'Starting…') )
	
	// Process one by one with a small delay to avoid rate limiting
	let index = 0
	
	function processNext() {
		
		if( cancelled || quotaBlocked || index >= total ) {
			
			processing = false
			showResults()
			return
		}
		
		let row = toProcess[index],
			id = row.id,
			title = row.title,
			url = row.url
		
		setProgress( index + 1, total,
			i18n.t('autotag:progress.processing', 'Processing {{current}} of {{total}}: {{title}}', {
				current: index + 1,
				total: total,
				title: title.substring( 0, 50 )
			})
		)
		
		// Chain: clear tags first (if checkbox checked), then call Gemini
		let promise = Promise.resolve()
		
		if( shouldClear ) {
			promise = clearAllTags( id )
		}			promise
			.then( () => tagBookmark( title, url, apiKey, primaryModel, maxTags, profile, existingVocab ) )
			.then( tags => {
				
				results.push({
					id: id,
					title: title,
					url: url,
					tags: tags,
					accepted: tags.length > 0,
					error: quotaBlocked ? i18n.t('autotag:results.quotaerror', 'API quota reached — run stopped') : undefined
				})
				
				// Brief delay to avoid hammering the API
				setTimeout( processNext, 300 )
			})
			.catch( error => {
				
				log.error( `auto-tag error for bookmark ${id}: ${error.message}` )
				
				results.push({
					id: id,
					title: title,
					url: url,
					tags: [],
					accepted: false,
					error: error.message
				})
				
				setTimeout( processNext, 300 )
			})
		
		index++
	}
	
	processNext()
}



//note(dgmid): one-line status under the footer buttons — what the last completed
//step was (run / apply)

function setActionStatus( text ) {
	
	$('#action-status').text( text || '' )
}



//note(dgmid): show review results

function showResults() {
	
	$('#step-progress').hide()
	$('#step-results').show()
	
	//note(dgmid): the results step already carries its own quota summary box — drop the
	//modal-level banner so it can't linger on screen while the user reviews or applies
	hideQuotaNotice()
	
	//note(dgmid): the run just finished — reflect it under the footer buttons
	setActionStatus( i18n.t( 'autotag:status.scanned', 'Run complete — review the suggested tags below.' ) )
	
	let accepted = results.filter( r => r.accepted && r.tags.length > 0 ).length,
		totalTags = results.reduce( (sum, r) => sum + (r.accepted ? r.tags.length : 0), 0 )
	
	let summaryHtml = i18n.t('autotag:summary.processed', 'Processed <strong>{{total}}</strong> bookmarks. <strong>{{accepted}}</strong> have suggested tags ({{tags}} total tags).', {
			total: results.length,
			accepted: accepted,
			tags: totalTags
		})
	
	//note(dgmid): when the run stopped early on API quota, say so clearly and up front —
	//a partial result otherwise looks like a routine "no tags" outcome.
	if( quotaBlocked ) {
		
		let eta = pacificMidnightETA(),
			processed = results.length - 1	// last item hit the quota wall and was not tagged
		
		summaryHtml = '<div style="margin:8px 0;padding:10px 12px;border-radius:6px;background:#fff3cd;border:1px solid #ffe08a;color:#7a5c00;font-size:12px;line-height:1.5;">' +
			i18n.t('autotag:summary.quota_box', '⚠ <strong>The run was stopped by the API quota.</strong> Only <strong>{{processed}}</strong> of {{total}} bookmarks were processed — the remaining <strong>{{left}}</strong> were NOT processed and keep their current tags. The quota resets at midnight Pacific Time (in about <strong>{{hours}}h {{minutes}}m</strong>). You can close this window — nothing else has been changed.', {
				processed: Math.max( 0, processed ),
				total: sessionTotal,
				left: Math.max( 0, sessionTotal - Math.max( 0, processed ) ),
				hours: eta.hours,
				minutes: eta.minutes
			}) +
			'</div>' + summaryHtml
	}
	
	$('#summary-stats').html( summaryHtml )
	
	let $list = $('#results-list').empty()
	
	if( results.length === 0 ) {
		
		$list.html( `<div class="empty-state">` + i18n.t('autotag:results.empty', 'No bookmarks were processed.') + `</div>` )
		
	} else {
		
		for( let i = 0; i < results.length; i++ ) {
			
			let r = results[i]
			
			if( !r.tags || r.tags.length === 0 ) {
				
				let reason = r.error
					? i18n.t('autotag:results.error', 'Error: {{error}}', { error: r.error })
					: i18n.t('autotag:results.notags', 'No relevant tags found')
				
				$list.append(`
					<div class="result-item" data-index="${i}">
						<div class="title">${r.title}</div>
						<div class="tags-row" style="opacity:.5;font-style:italic;">
							${reason}
						</div>
					</div>
				`)
				continue
			}
			
			let tagHtml = r.tags.map( (tag, ti) => `
				<span class="tag-badge ${r.accepted ? '' : 'rejected'}" data-result="${i}" data-tag="${ti}"
				      title="` + i18n.t('autotag:results.clicktoggle', 'Click to toggle') + `">
					${tag}
				</span>
			`).join('')
			
			let statusIcon = r.accepted ? '✅' : '⏸️'
			
			$list.append(`
				<div class="result-item" data-index="${i}">
					<div class="title"><span class="status-icon">${statusIcon}</span>${r.title}</div>
					<div class="tags-row">${tagHtml}</div>
				</div>
			`)
		}
	}
	
	// Show buttons, restore Close label
	$('#btn-accept-all').show()
	$('#btn-apply').show()
	$('#btn-close').text( i18n.t('autotag:button.close', 'Close') )
}



//note(dgmid): toggle individual tag acceptance

$('#results-list').on('click', '.tag-badge', function() {
	
	let idx = parseInt( $(this).data('result') ),
		r = results[idx]
	
	if( !r ) return
	
	$(this).toggleClass('rejected')
	
	// Update acceptance state — if any tag is rejected, the bookmark is not fully accepted
	let allRejected = r.tags.every( (_, ti) => {
		return $(`.tag-badge[data-result="${idx}"][data-tag="${ti}"]`).hasClass('rejected')
	})
	
	r.accepted = !allRejected
})



//note(dgmid): accept all

$('#btn-accept-all').click( function() {
	
	$('.tag-badge').removeClass('rejected')
	
	results.forEach( r => {
		if( r.tags && r.tags.length > 0 ) r.accepted = true
	})
	
	// Update status icons
	$('.result-item .status-icon').text('✅')
	
	// Visual feedback
	let $btn = $(this)
	let origText = $btn.text()
	$btn.text( '✓ ' + origText ).css('background', 'var(--accent)').prop('disabled', true)
	setTimeout( () => {
		$btn.text( origText ).css('background', '').prop('disabled', false)
	}, 800 )
})



//note(dgmid): apply accepted tags to server

$('#btn-apply').click( function() {
	
	//note(dgmid): the user is now applying — drop the quota banner so it can't linger
	hideQuotaNotice()
	
	let toApply = results.filter( r => r.accepted && r.tags.length > 0 )
	
	if( toApply.length === 0 ) {
		
		ipcRenderer.send('show-error-box', {
			title: i18n.t('autotag:error.notags_title', 'No Tags to Apply'),
			content: i18n.t('autotag:error.notags_content', 'No bookmarks have accepted tags. Toggle tags or use Accept All first.')
		})
		return
	}
	
	$('#btn-apply').prop('disabled', true).text( i18n.t('autotag:button.applying', 'Applying…') )
	
	let fetch = require( './fetch.min' )
	let applied = 0,
		failed = 0
	
	function applyNext( idx ) {
		
		if( idx >= toApply.length ) {
			
			let msg = i18n.t('autotag:done.applied', 'Applied tags to {{applied}} bookmarks.', {applied: applied})
			if( failed > 0 ) {
				msg += ' ' + i18n.t('autotag:done.failed', '{{failed}} failed.', {failed: failed})
			}
			
			ipcRenderer.send('show-error-box', {
				title: i18n.t('autotag:done.title', 'Auto-Tag Complete'),
				content: msg
			})
			
			//note(dgmid): pass the applied tags back through IPC so the main window can
			//update those rows instantly instead of re-downloading all bookmarks.
			ipcRenderer.send( 'refresh', {
				action: 'tag-updates',
				data: toApply.map( r => ({ id: r.id, tags: r.tags }) )
			})
			
			$('#btn-apply').prop('disabled', false).text( i18n.t('autotag:button.apply', 'Apply to Server') )
			
			//note(dgmid): mark the apply step as done — the tags were written
			$('#btn-apply').addClass( 'done' )
			setActionStatus( i18n.t( 'autotag:status.applied', 'Tags applied to the server ({{count}} bookmarks).', { count: applied } ) )
			return
		}
		
		let r = toApply[idx],
			tagsParam = r.tags.map( t => `tags[]=${encodeURIComponent(t)}` ).join('&')
		
		//note(dgmid): retry transient network failures (laptop sleep, Wi-Fi drop)
		fetch.modifyWithRetry( r.id, `?${tagsParam}`, 2, function( response ) {
			
			if( response !== null ) {
				applied++
			} else {
				failed++
				log.error( `auto-tag apply failed for bookmark ${r.id}: modify API returned null after retries` )
			}
			
			$('#btn-apply').text(
				i18n.t('autotag:button.applying_progress', 'Applying… {{current}}/{{total}}', {
					current: idx + 1,
					total: toApply.length
				})
			)
			
			// Small delay between API calls
			setTimeout( () => applyNext( idx + 1 ), 200 )
		})
	}
	
	applyNext( 0 )
})



//note(dgmid): profile change — refresh the vocabulary preview

$('#profile-select').on('change', renderProfilePreview)



//note(dgmid): start button

$('#btn-start').click( function() {
	
	processBookmarks()
})



//note(dgmid): close / cancel button — always visible

$('#btn-close').click( function() {
	
	if( processing ) {
		
		cancelled = true
	}
	
	// Close immediately — the cancelled flag will stop the processing loop
	ipcRenderer.send( 'close-current-window' )
})
