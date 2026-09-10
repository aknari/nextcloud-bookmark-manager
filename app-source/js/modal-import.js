'use strict'

const i18n			= require( './i18n.min' )

// Polyfill: make electron-store work in renderer
try {
	const electron = require( 'electron' )
	const remote = require( '@electron/remote' )
	if( !electron.app ) electron.app = remote.app
} catch( e ) {}

const { ipcRenderer } = require( 'electron' )
const Store			= require( 'electron-store' )
const store			= new Store()
const $				= require( 'jquery' )
const jqueryI18next = require( 'jquery-i18next' )
jqueryI18next.init(i18n, $)
const fs			= require( 'fs-extra' )
const log			= require( 'electron-log' )

const ncAPI			= require( './fetch.min' )



//note(dgmid): log exceptions

window.onerror = function( error, url, line ) {
	
	ipcRenderer.send( 'error-in-render', {error, url, line} )
}



// Setup localization
$('html').attr('lang', i18n.language)
$('header').localize()
$('p').localize()
$('button').localize()



// Close modal
function closeModal() {
	
	ipcRenderer.send( 'close-current-window' )
}



// Parse Netscape Bookmark Format HTML
function parseBookmarkFile( html ) {
	
	let bookmarks = []
	
	// Match all <A ...>...</A> tags with HREF and optional TAGS
	let regex = /<A\s+[^>]*HREF\s*=\s*"([^"]*)"([^>]*)>([^<]*)<\/A>/gi
	let descRegex = /<DD>([^<]*)/gi
	
	let match,
		descMatch,
		descriptions = []
	
	// Collect descriptions in order
	while( (descMatch = descRegex.exec( html ) ) !== null ) {
		
		descriptions.push( descMatch[1].trim() )
	}
	
	let descIndex = 0
	
	while( (match = regex.exec( html ) ) !== null ) {
		
		let url			= match[1].trim(),
			attrs		= match[2],
			title		= match[3].trim()
		
		// Extract TAGS attribute
		let tagMatch = attrs.match( /TAGS\s*=\s*"([^"]*)"/i )
		let tags = tagMatch ? tagMatch[1].split(',').map(t => t.trim()).filter(t => t) : []
		
		// Description (may not exist for every bookmark)
		let description = descriptions[descIndex] || ''
		descIndex++
		
		// Skip empty URLs
		if( url ) {
			
			bookmarks.push({
				url: url,
				title: title,
				tags: tags,
				description: description
			})
		}
	}
	
	return bookmarks
}



// Build a map of existing URLs from stored bookmarks
function buildExistingMap() {
	
	let bookmarkStore
	try {
		bookmarkStore = new Store( {name: 'bookmarks'} )
	} catch(e) {
		log.error( 'import: could not open bookmarks store' )
		return {}
	}
	
	let data = bookmarkStore.get( 'data' )
	
	if( !data || !Array.isArray( data ) ) {
		
		return {}
	}
	
	let map = {}
	
	for( let item of data ) {
		
		if( !item.url ) continue
		
		let normalizedUrl = item.url.toLowerCase().replace(/\/+$/, '')
		
		if( !map[normalizedUrl] ) {
			
			map[normalizedUrl] = []
		}
		
		map[normalizedUrl].push({
			id: item.id,
			title: item.title,
			tags: item.tags || [],
			folders: item.folders || []
		})
	}
	
	return map
}



// Check imports against existing bookmarks
function checkDuplicates( importList, existingMap ) {
	
	let result = {
		toAdd: [],       // New bookmarks to import
		toSkip: [],      // Same URL + same title → skip
		conflicts: []    // Same URL, different title
	}
	
	for( let item of importList ) {
		
		let normalizedUrl = item.url.toLowerCase().replace(/\/+$/, '')
		let existing = existingMap[normalizedUrl]
		
		if( !existing ) {
			
			// URL doesn't exist → add
			result.toAdd.push( item )
		
		} else {
			
			// URL exists → check if any existing has the same title
			let sameTitle = existing.some( e => {
				
				return e.title && e.title.toLowerCase().trim() === item.title.toLowerCase().trim()
			})
			
			if( sameTitle ) {
				
				result.toSkip.push( item )
			
			} else {
				
				result.conflicts.push({
					imported: item,
					existing: existing[0],  // First match for reference
					chosenTitle: item.title  // Default: use the imported title (editable)
				})
			}
		}
	}
	
	return result
}



// Add a bookmark via API
function addBookmark( item, callback ) {
	
	let data = 'url=' + encodeURIComponent( item.url ) +
		'&title=' + encodeURIComponent( item.title ) +
		'&description=' + encodeURIComponent( item.description )
	
	for( let tag of item.tags ) {
		
		data += '&tags[]=' + encodeURIComponent( tag )
	}
	
	// Default folder: -1 (Home)
	data += '&folders[]=-1'
	
	ncAPI.bookmarksApi( 'add', '', data, function( message ) {
		
		if( message ) {
			
			try {
				let returnedBookmark = JSON.parse( message )
				ipcRenderer.send( 'update-favicon', returnedBookmark['item'] )
			} catch(e) {
				log.error( 'import: could not parse add response: ' + e.message )
			}
		}
		
		callback()
	})
}



$(document).ready(function() {
	
	// Hide Close button initially, show Cancel
	$('#close').hide()
	
	
	// Cancel button
	$('#cancel').click( function() {
		
		closeModal()
	})
	
	
	// Close button (appears after import completes)
	$('#close').click( function() {
		
		closeModal()
	})
	
	
	// Handle file selection via native HTML input
	// Note: The button is a <label for="file-input">, so clicking it
	// opens the file dialog natively even if JavaScript fails to load.
	$('#file-input').on( 'change', function() {
		
		let filePath = $(this).val()
		
		if( !filePath ) return
		
		// Clear the input so the user can re-select the same file if needed
		$(this).val('')
		
		$('#filename').text( filePath.split('\\').pop().split('/').pop() )
		
		try {
			
			let content = fs.readFileSync( filePath, 'utf8' )
			let bookmarks = parseBookmarkFile( content )
			
			if( bookmarks.length === 0 ) {
				
				$('#filename').text( filePath.split('\\').pop().split('/').pop() + ' — ' + i18n.t('import:body.nobookmarks', 'No bookmarks found in file') )
				return
			}
			
			// Show preview
			$('#preview-count').text( bookmarks.length )
			
			let previewHtml = ''
			let maxPreview = Math.min( bookmarks.length, 50 )
			
			for( let i = 0; i < maxPreview; i++ ) {
				
				previewHtml += `<div style="padding: 2px 0; border-bottom: 1px solid #eee;">
					<span title="${bookmarks[i].url}" style="color: #0082c9;">${bookmarks[i].title || '(no title)'}</span>
					<span style="color: #999; font-size: 10px; margin-left: 4px;">${bookmarks[i].url.substring(0, 60)}</span>
				</div>`
			}
			
			if( bookmarks.length > 50 ) {
				
				previewHtml += `<div style="color: #999; font-style: italic; padding: 4px 0;">
					${i18n.t('import:body.andmore', '… and {{count}} more', {count: bookmarks.length - 50})}
				</div>`
			}
			
			$('#preview-list').html( previewHtml )
			
			// Store bookmarks for import
			$('#step-file').hide()
			$('#step-preview').show()
			$('#step-preview').data( 'bookmarks', bookmarks )
			
		} catch(e) {
			
			log.error( 'import: error reading file: ' + e.message )
			ipcRenderer.send( 'error-in-render', {error: 'import: ' + e.message, url: 'modal-import.js', line: 0} )
			$('#filename').text( filePath.split('\\').pop().split('/').pop() + ' — ' + i18n.t('import:body.readerror', 'Error reading file') )
		}
	})
	
	
	// Start Import button
	$('#start-import').click( function() {
		
		let bookmarks = $('#step-preview').data( 'bookmarks' )
		
		if( !bookmarks || bookmarks.length === 0 ) return
		
		// Build existing map and check duplicates
		let existingMap = buildExistingMap()
		let checkResult = checkDuplicates( bookmarks, existingMap )
		
		if( checkResult.conflicts.length > 0 ) {
			
			// Show conflicts
			showConflicts( checkResult )
			return
		}
		
		// No conflicts → import directly
		runImport( checkResult.toAdd, [] )
	})
	
	
	// Import Confirmed button (after resolving conflicts)
	$('#import-confirmed').click( function() {
		
		// Read chosen titles from conflict inputs
		let conflicts = $('#step-conflicts').data( 'conflicts' ) || []
		let resolvedConflicts = []
		
		$('.conflict-title-input').each( function( idx ) {
			
			let newTitle = $(this).val().trim()
			
			if( newTitle && idx < conflicts.length ) {
				
				resolvedConflicts.push({
					...conflicts[idx].imported,
					title: newTitle
				})
			}
		})
		
		// Get the toAdd list
		let toAdd = $('#step-conflicts').data( 'toAdd' ) || []
		
		// Run import with resolved conflicts as additional items to add
		runImport( toAdd.concat( resolvedConflicts ), [] )
	})
	
	
	// Skip All Conflicts button
	$('#skip-conflicts').click( function() {
		
		let toAdd = $('#step-conflicts').data( 'toAdd' ) || []
		
		runImport( toAdd, [] )
	})
	
	
	
	// Show conflicts UI
	function showConflicts( checkResult ) {
		
		let conflictHtml = ''
		
		for( let conflict of checkResult.conflicts ) {
			
			conflictHtml += `<div style="padding: 4px 0; border-bottom: 1px solid #eee; font-size: 11px;">
				<div style="color: #0082c9;">${conflict.imported.title}</div>
				<div style="color: #999;">${conflict.imported.url.substring(0, 80)}</div>
				<div style="color: #c00; font-size: 10px;">
					${i18n.t('import:body.existingtitle', 'Existing title')}: "${conflict.existing.title}"
				</div>
				<div style="margin-top: 2px;">
					<input type="text" class="conflict-title-input" value="${conflict.imported.title.replace(/"/g, '&quot;')}" style="width: 100%; font-size: 11px; padding: 2px 4px; border: 1px solid #ccc; border-radius: 3px;">
				</div>
			</div>`
		}
		
		$('#conflicts-list').html( conflictHtml )
		$('#step-conflicts').data( 'conflicts', checkResult.conflicts )
		$('#step-conflicts').data( 'toAdd', checkResult.toAdd )
		
		$('#step-preview').hide()
		$('#step-conflicts').show()
	}
	
	
	
	// Run the actual import
	function runImport( toAdd, toSkip ) {
		
		let total = toAdd.length
		
		if( total === 0 ) {
			
			$('#step-preview').hide()
			$('#step-conflicts').hide()
			$('#step-progress').show()
			$('#progress-bar').css( 'width', '100%' )
			$('#progress-text').text( i18n.t('import:progress.noneeded', 'No new bookmarks to import') )
			$('#import-results').html( '<div style="color: #999;">' + i18n.t('import:body.alldone', 'All bookmarks already exist in your collection.') + '</div>' )
			
			$('#cancel').hide()
			$('#close').show()
			return
		}
		
		$('#step-preview').hide()
		$('#step-conflicts').hide()
		$('#step-progress').show()
		
		let added = 0,
			skipped = toSkip.length,
			errors = 0
		
		function updateProgress() {
			
			let pct = Math.round( (added + errors) / total * 100 )
			$('#progress-bar').css( 'width', pct + '%' )
			$('#progress-text').text(
				i18n.t('import:progress.adding', 'Importing {{added}} of {{total}}…', {added: added + errors, total: total})
			)
		}
		
		function finalize() {
			
			$('#progress-bar').css( 'width', '100%' )
			$('#progress-text').text(
				i18n.t('import:progress.done', 'Done — {{added}} imported, {{skipped}} skipped, {{errors}} errors', {added: added, skipped: skipped, errors: errors})
			)
			$('#import-results').append( '<div style="color: #090; margin-top: 4px;">' + 
				i18n.t('import:body.final', 'Import complete. {{added}} bookmarks added.', {added: added}) +
				'</div>' )
			
			$('#cancel').hide()
			$('#close').show()
			
			// Trigger refresh in main window
			ipcRenderer.send( 'refresh', 'refresh' )
		}
		
		
		if( total === 0 ) {
			
			finalize()
			return
		}
		
		// Process bookmarks one by one (sequential to avoid overwhelming the server)
		let index = 0
		
		function processNext() {
			
			if( index >= total ) {
				
				finalize()
				return
			}
			
			let item = toAdd[index]
			index++
			
			updateProgress()
			
			addBookmark( item, function() {
				
				added++
				$('#import-results').append( `<div style="color: #090; padding: 1px 0;">✓ ${item.title || item.url.substring(0, 40)}</div>` )
				processNext()
			})
		}
		
		// Start with concurrent batch of 3
		let batchSize = Math.min( 3, total )
		
		for( let i = 0; i < batchSize; i++ ) {
			
			processNext()
		}
	}
})
