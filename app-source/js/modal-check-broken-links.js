'use strict'

const i18n = require( './i18n.min' )

// Polyfill: make electron-store work in renderer
try {
	const electron = require( 'electron' )
	const remote = require( '@electron/remote' )
	if( !electron.app ) electron.app = remote.app
} catch( e ) {}

const ipc = require( 'electron' ).ipcRenderer

const httpReq = require( './http-request.min' )

const Store = require( 'electron-store' )
const store = new Store()
const $ = require( 'jquery' )
const jqueryI18next = require( 'jquery-i18next' )

jqueryI18next.init(i18n, $)

const ncAPI = require( './fetch.min' )
const entities = require( './entities.min' )

// Access the bookmarks data store
let bookmarkStore = new Store({name: 'bookmarks'})



//note(dgmid): log exceptions

window.onerror = function( error, url, line ) {
	
	ipc.send( 'error-in-render', {error, url, line} )
}



//note(dgmid): set lang & localize strings

$('html').attr('lang', i18n.language)
$('header').localize()
$('button').localize()



//note(dgmid): close modal

function closeModal() {
	
	ipc.send( 'close-current-window' )
}



//note(dgmid): ============================================================
// SCOPE — which bookmarks to check. Mirrors the auto-tag modal:
//   selection mode → exactly the selected bookmarks (passed via store)
//   folder mode    → the current folder's bookmarks, optionally recursive
//                    (via the "include subfolders" checkbox)
//   all mode       → the whole catalogue (the original behaviour; used when
//                    neither a selection nor a specific folder applies)
// ============================================================

let context 		= null,			// { folderId, folderName } from the main window
	selection 		= [],			// [{ id, title, url }] selected rows
	scopeMode 		= 'all'			// 'selection' | 'folder' | 'all'

context 	= store.get( '_brokenLinksContext' ) || null
selection 	= store.get( '_brokenLinksSelection' ) || []

if( selection.length > 0 ) {
	
	scopeMode = 'selection'
	
} else if( context && context.folderId != null && context.folderId !== -1 ) {
	
	scopeMode = 'folder'
	
} else {
	
	scopeMode = 'all'
}



//note(dgmid): degraded mode — the server rejects the session. The check still
//runs against the local mirror, but results cannot be saved to the server.

let degradedMode = !!store.get( '_serverDegraded' )

if( degradedMode ) {
	
	$('#degraded-note').text( i18n.t('checkbroken:degraded.note', 'Server unreachable or session rejected — broken links will be detected but NOT saved to the server.') ).show()
}



//note(dgmid): ids of every folder under parentId (recursive) — used by the
//"include bookmarks in subfolders" option in folder mode

function getDescendantIds( folders, parentId ) {
	
	let result 	= [],
		queue 	= [ parentId ]
	
	while( queue.length ) {
		
		let cur = queue.shift()
		
		for( let f of folders ) {
			
			let parent = ( f.parent_folder == null || f.parent_folder === -1 || f.parent_folder === '-1' ) ? -1 : f.parent_folder
			
			if( parent === cur && !result.includes( f.id ) ) {
				
				result.push( f.id )
				queue.push( f.id )
			}
		}
	}
	
	return result
}



//note(dgmid): filter the full bookmark list down to the current scope. Selection
//mode keeps exactly the selected ids; folder mode keeps bookmarks whose folder
//membership intersects the folder (direct or recursive); all mode keeps everything.

function computeScopeBookmarks( bookmarkData ) {
	
	if( scopeMode === 'selection' ) {
		
		let ids = new Set( selection.map( s => s.id ) )
		
		return bookmarkData.filter( b => ids.has( b.id ) )
	}
	
	if( scopeMode === 'folder' ) {
		
		let fid 		= ( context && context.folderId != null ) ? context.folderId : -1,
			recursive 	= $('#chk-include-subfolders').is( ':checked' ),
			folders 	= store.get( 'folders' ) || []
		
		let ids = new Set( recursive ? getDescendantIds( folders, fid ) : [] )
		ids.add( fid )
		
		return bookmarkData.filter( b => ( b.folders || [] ).some( f => ids.has( f ) ) )
	}
	
	return bookmarkData
}



//note(dgmid): recompute the folder-mode count from the cached bookmark mirror
//(the main window fetches on every startup, so the count is accurate enough to
//display before the run starts; the run re-fetches fresh data anyway).

function refreshFolderCount() {
	
	let data = bookmarkStore.get( 'data' )
	
	if( !data || !Array.isArray( data ) ) {
		
		$('#cfg-count').text( '—' )
		return
	}
	
	$('#cfg-count').text( String( computeScopeBookmarks( data ).length ) )
}



//note(dgmid): show the scope summary in the modal

function setupScope() {
	
	if( scopeMode === 'selection' ) {
		
		$('#selection-scope').show()
		$('#cfg-selectedbm').text(
			i18n.t('checkbroken:label.selected_count', '{{selected}} bookmarks selected', {selected: selection.length})
		)
		
	} else if( scopeMode === 'folder' ) {
		
		$('.folder-scope').show()
		$('#cfg-folder').text( context.folderName || 'Home' )
		refreshFolderCount()
		
	} else {
		
		$('#all-scope').show()
	}
}



//note(dgmid): check a single URL using Node's http/https module (not browser fetch)

async function isBroken( url, timeoutMs ) {
	
	timeoutMs = timeoutMs || 10000
	
	// Skip empty URLs
	if( !url || url === '' ) {
		
		ipc.send( 'error-in-render', {error: '[BROKEN] skipping empty URL', url: 'check-broken-links.js', line: 0} )
		return false
	}
	
	try {
		
		// Try HEAD first
		let headResult
		try {
			
			headResult = await httpReq.nodeRequest( url, 'HEAD', timeoutMs )
			
		} catch( headErr ) {
			
			// HEAD failed (network error, SSL, CORS, etc.) — will try GET
			headResult = null
		}
		
		if( headResult ) {
			
			let status = headResult.status
			
			// 2xx-3xx → not broken
			if( status >= 200 && status < 400 ) {
				
				return false
			}
			
			// Log what happened, then fall through to GET for confirmation
			// (some sites return fake 4xx/5xx to automated HEAD requests)
			if( status === 404 || status === 410 ) {
				
				ipc.send( 'error-in-render', {error: '[BROKEN] ' + url + ' = ' + status + ' (page not found, trying GET)', url: 'check-broken-links.js', line: 0} )
				
			} else if( status === 400 || status === 401 || status === 402 || status === 403 ||
				   status === 405 || status === 417 || status === 418 || status === 429 ||
				   status === 451 ) {
				
				// Known automation/config blocks — try GET to be sure
				ipc.send( 'error-in-render', {error: '[BROKEN] ' + url + ' = ' + status + ' (may block automation, trying GET)', url: 'check-broken-links.js', line: 0} )
				
			} else if( status >= 400 && status < 500 ) {
				
				// Other 4xx — fall through to GET
				ipc.send( 'error-in-render', {error: '[BROKEN] ' + url + ' = ' + status + ' (trying GET)', url: 'check-broken-links.js', line: 0} )
				
			} else if( status >= 500 ) {
				
				// 5xx — try GET (server might not support HEAD)
				ipc.send( 'error-in-render', {error: '[BROKEN] ' + url + ' = ' + status + ' (server error, trying GET)', url: 'check-broken-links.js', line: 0} )
			}
		}
		
		// Try GET as fallback (for: all non-2xx-3xx HEAD responses + network errors)
		try {
			
			let getResult = await httpReq.nodeRequest( url, 'GET', timeoutMs )
			let status = getResult.status
			
			// GET succeeded (2xx-3xx) → not broken
			if( status >= 200 && status < 400 ) {
				
				ipc.send( 'error-in-render', {error: '[OK] GET ' + url + ' = ' + status + ' (URL is accessible)', url: 'check-broken-links.js', line: 0} )
				return false
			}
			
			// GET returned 404/410 — check body size to detect false positives
			// Many SPAs and anti-bot systems return 404 with a full page body (>3KB)
			// Real 404 pages are typically small (<1KB)
			if( status === 404 || status === 410 ) {
				
				// Re-request with body capture to check the page size
				let bodyInfo
				try {
					bodyInfo = await httpReq.nodeRequest( url, 'GET', timeoutMs, 0, true )
				} catch( bodyErr ) {}
				
				const MIN_SPA_BODY = 3072 // 3KB — SPAs and anti-bot pages are larger than this
				
				if( bodyInfo && bodyInfo.bodyLength > MIN_SPA_BODY ) {
					
					ipc.send( 'error-in-render', {error: '[BROKEN] ' + url + ' = ' + status + ' (got ' + bodyInfo.bodyLength + ' byte body — likely SPA/anti-bot, NOT broken)', url: 'check-broken-links.js', line: 0} )
					return false
				}
				
				ipc.send( 'error-in-render', {error: '[BROKEN] ' + url + ' = ' + status + ' (confirmed not found)', url: 'check-broken-links.js', line: 0} )
				return true
			}
			
			// Known automation/config blocks → NOT broken
			if( status === 400 || status === 401 || status === 402 || status === 403 ||
				status === 405 || status === 417 || status === 418 || status === 429 ||
				status === 451 ) {
				
				ipc.send( 'error-in-render', {error: '[BROKEN] ' + url + ' = ' + status + ' (site blocks automation/config, NOT broken)', url: 'check-broken-links.js', line: 0} )
				return false
			}
			
			// Other 4xx from GET → broken
			if( status >= 400 && status < 500 ) {
				
				ipc.send( 'error-in-render', {error: '[BROKEN] ' + url + ' = ' + status, url: 'check-broken-links.js', line: 0} )
				return true
			}
			
			// 5xx from GET → retry once after 1s (transient server error)
			if( status >= 500 ) {
				
				ipc.send( 'error-in-render', {error: '[BROKEN] ' + url + ' = ' + status + ' (retrying once after 1s)', url: 'check-broken-links.js', line: 0} )
				
				await new Promise( r => setTimeout( r, 1000 ) )
				
				try {
					
					let retryResult = await httpReq.nodeRequest( url, 'GET', timeoutMs )
					let retryStatus = retryResult.status
					
					// Retry succeeded → was transient, not broken
					if( retryStatus >= 200 && retryStatus < 400 ) {
						
						ipc.send( 'error-in-render', {error: '[OK] GET (retry) ' + url + ' = ' + retryStatus + ' (transient error, URL is accessible)', url: 'check-broken-links.js', line: 0} )
						return false
					}
					
					// Retry still returned 5xx — broken
					if( retryStatus >= 500 ) {
						
						ipc.send( 'error-in-render', {error: '[BROKEN] ' + url + ' = ' + retryStatus + ' (confirmed after retry)', url: 'check-broken-links.js', line: 0} )
						return true
					}
					
					// Retry returned other status (e.g. 404 instead of 5xx) — check normally
					// Continue to the standard status-based checks below
					status = retryStatus
					
				} catch( retryErr ) {
					
					ipc.send( 'error-in-render', {error: '[BROKEN] ' + url + ' retry also failed: ' + retryErr.message, url: 'check-broken-links.js', line: 0} )
					
					// Retry still failing → broken
					return true
				}
			}
			
			// Fallback: any other status → broken
			ipc.send( 'error-in-render', {error: '[BROKEN] ' + url + ' = ' + status, url: 'check-broken-links.js', line: 0} )
			return true
			
		} catch( getErr ) {
			
			// GET also failed — check the error type
			let errMsg = getErr.message.toLowerCase()
			
			ipc.send( 'error-in-render', {error: '[BROKEN] GET also failed for ' + url + ': ' + getErr.message, url: 'check-broken-links.js', line: 0} )
			
			// SSL errors are often false positives (local SSL inspection, CDN issues)
			if( errMsg.includes('cert') || errMsg.includes('ssl') || errMsg.includes('tls') ) {
				
				ipc.send( 'error-in-render', {error: '[BROKEN] ' + url + ' - SSL error (likely false positive, NOT broken)', url: 'check-broken-links.js', line: 0} )
				return false
			}
			
			// Timeout — the site might just be slow (user confirms some slow sites work)
			if( errMsg.includes('timeout') || errMsg.includes('timed out') ) {
				
				ipc.send( 'error-in-render', {error: '[BROKEN] ' + url + ' - timeout (site may be slow, NOT broken)', url: 'check-broken-links.js', line: 0} )
				return false
			}
			
			// DNS/connection errors → broken
			return true
		}
		
	} catch( e ) {
		
		ipc.send( 'error-in-render', {error: '[BROKEN] unexpected error checking ' + url + ': ' + e.message, url: 'check-broken-links.js', line: 0} )
		return true
	}
}



//note(dgmid): ============================================================
// RUN STATE — the checking loop is a small worker pool (CONCURRENCY parallel
// requests). It can be paused (user closes mid-run → summary panel) and
// resumed (Continue Checking) without losing progress.
// ============================================================

const CONCURRENCY = 5

let workingBookmarks 	= [],	// full bookmark objects in scope
	total 				= 0,
	checked 			= 0,
	nextIndex 			= 0,
	inFlight 			= 0,
	brokenItems 		= [],	// items found broken this run
	runActive 			= false,
	runFinished 		= false,
	paused 				= false,
	allowClose 			= false



//note(dgmid): process the next item in the queue; returns early when paused or done

function pump() {
	
	if( paused || runFinished || !runActive ) return
	
	if( nextIndex >= total ) {
		
		if( inFlight === 0 ) finish()
		return
	}
	
	let item = workingBookmarks[ nextIndex++ ]
	
	inFlight++
	
	//note(dgmid): settle-guard — the HTTP layer already times out every request, but
	//this guarantees a single exotic renderer error can never stall a worker forever
	//(which would freeze the whole pool). If the safety net fires, the URL is treated
	//as "not broken" so the run keeps moving; it's recorded in the log.
	let settled 	= false,
		guardTimer 	= null
	
	function onResult( result ) {
		
		if( settled ) return
		settled = true
		
		inFlight--
		checked++
		
		let pct = Math.round( (checked / total) * 100 )
		$('#progress-bar').css( 'width', pct + '%' )
		$('#status').html( `<div>${i18n.t('checkbroken:status.checking', 'Checking {{current}} of {{total}}…', {current: checked, total: total})}</div><div class="current-url">${entities.encode(item.url)}</div>` )
		
		if( result ) brokenItems.push( item )
		
		pump()
	}
	
	isBroken( item.url ).then( result => {
		
		clearTimeout( guardTimer )
		onResult( result )
	})
	
	guardTimer = setTimeout( () => {
		
		ipc.send( 'error-in-render', {error: '[BROKEN] safety-net timeout for ' + item.url + ' (treated as accessible)', url: 'check-broken-links.js', line: 0} )
		onResult( false )
	}, 45000 )
}



//note(dgmid): the run finished checking — show the broken list and tag them

function finish() {
	
	runActive 	= false
	runFinished = true
	
	$('#progress-bar').hide()
	$('#status').html( '' )
	
	if( brokenItems.length === 0 ) {
		
		$('#results').show()
		$('#results').html( `<div class="summary">${i18n.t('checkbroken:summary.none', 'All {{total}} bookmarks are accessible.', {total: total})}</div>` )
		$('#btn-close').text( i18n.t('checkbroken:button.close', 'Close') )
		return
	}
	
	showBrokenList( brokenItems )
	
	if( degradedMode ) {
		
		//note(dgmid): server unreachable — the tags cannot be saved; say so honestly
		$('#status').html( `<div class="summary">${i18n.t('checkbroken:degraded.note', 'Server unreachable or session rejected — broken links will be detected but NOT saved to the server.')}</div>` )
		$('#btn-close').text( i18n.t('checkbroken:button.close', 'Close') )
		return
	}
	
	$('#status').html( `<div>${i18n.t('checkbroken:status.tagging', 'Tagging broken links…', {tagged: 0, total: brokenItems.length})}</div>` )
	
	tagBroken( brokenItems ).then( () => {
		
		//note(dgmid): if the server went degraded mid-run, tagging was blocked — be honest
		if( store.get( '_serverDegraded' ) ) {
			
			$('#status').html( `<div class="summary">${i18n.t('checkbroken:degraded.note', 'Server unreachable or session rejected — broken links will be detected but NOT saved to the server.')}</div>` )
			
		} else {
			
			$('#status').html( `<div class="summary">${i18n.t('checkbroken:summary.done', 'Done! {{count}} bookmark(s) tagged as "broken".', {count: brokenItems.length})}</div>` )
		}
		
		$('#btn-close').text( i18n.t('checkbroken:button.close', 'Close') )
		
		// Refresh the main window to show updated tags and icons
		ipc.send( 'refresh', 'refresh' )
	})
}



//note(dgmid): render the list of broken links

function showBrokenList( items ) {
	
	let html = `<div class="summary">${i18n.t('checkbroken:summary.found', '{{count}} broken link(s) found.', {count: items.length})}</div>`
	
	for( let item of items ) {
		
		html += `<div class="broken-item">`
		html += `<span class="title">⚠ ${entities.encode(item.title || '—')}</span>`
		html += `<div class="meta">${entities.encode(item.url)}</div>`
		html += `</div>`
	}
	
	$('#results').show()
	$('#results').html( html )
}



//note(dgmid): add the 'broken' tag to each item, sequentially, with a safety
//timeout per bookmark so the queue never hangs. Returns a Promise.

function tagBroken( items ) {
	
	return new Promise( (resolve) => {
		
		let tagged 	= 0,
			idx 	= 0
		
		function tagNext() {
			
			if( idx >= items.length ) { resolve(); return }
			
			let item = items[ idx++ ]
			
			// Build modify data with existing tags + 'broken'
			let allTags = item.tags || []
			if( !allTags.includes( 'broken' ) ) allTags.push( 'broken' )
			
			let data = '?record_id=' + encodeURIComponent( item.id )
			data += '&url=' + encodeURIComponent( item.url )
			data += '&title=' + encodeURIComponent( item.title || '' )
			data += '&description=' + encodeURIComponent( item.description || '' )
			
			for( let tag of allTags ) {
				
				data += '&tags[]=' + encodeURIComponent( tag )
			}
			
			for( let f of (item.folders || []) ) {
				
				data += '&folders[]=' + encodeURIComponent( f )
			}
			
			// This is sequential to avoid overwhelming the server
			// Add a safety timeout so we never hang if the API callback doesn't fire
			let taggingTimeout
			
			Promise.race([
				new Promise( (r) => {
					
					ncAPI.bookmarksApi( 'modify', item.id, data, function() {
						
						clearTimeout( taggingTimeout )
						
						//note(dgmid): in degraded mode the write is blocked by fetch.js —
						//don't count it so the summary doesn't claim tags were saved
						if( !store.get( '_serverDegraded' ) ) {
							
							tagged++
							$('#status').html( `<div>${i18n.t('checkbroken:status.tagging', 'Tagging broken links… ({{tagged}}/{{total}})', {tagged: tagged, total: items.length})}</div>` )
						}
						
						r()
					})
				}),
				new Promise( r => {
					
					taggingTimeout = setTimeout( () => {
						
						ipc.send( 'error-in-render', {error: '[BROKEN] tagging timeout for bookmark ' + item.id, url: 'check-broken-links.js', line: 0} )
						tagged++
						r()
					}, 15000 )
				})
			]).then( tagNext )
		}
		
		tagNext()
	})
}



//note(dgmid): run the broken link check over the current scope

async function runCheck() {
	
	//note(dgmid): hide Start immediately so a double-click can't launch two runs
	//while the initial fetch is still in flight
	$('#btn-start').hide()
	
	// Clean the previous 'broken' tags ONLY in all mode: the server-wide deletetag
	// would wrongly un-tag broken bookmarks that are OUTSIDE the current scope. In
	// scope modes the local strip below takes care of the working set only.
	if( scopeMode === 'all' ) {
		
		$('#status').html( `<div>${i18n.t('checkbroken:status.cleaning', 'Cleaning previous "broken" tag…')}</div>` )
		
		await new Promise( (resolve) => {
			
			ncAPI.bookmarksApi( 'deletetag', '', 'broken', function() {
				
				resolve()
			})
		})
	}
	
	// Re-fetch bookmarks to get fresh data without the old 'broken' tags
	$('#status').html( `<div>${i18n.t('checkbroken:status.fetching', 'Fetching bookmarks…')}</div>` )
	
	await new Promise( (resolve) => {
		
		ncAPI.bookmarksApi( 'all', '', '', function( data ) {
			
			resolve()
		})
	})
	
	let bookmarkData = bookmarkStore.get( 'data' )
	
	if( !bookmarkData || !Array.isArray( bookmarkData ) ) {
		
		$('#status').html( `<div class="summary">${i18n.t('checkbroken:error.nodata', 'No bookmark data available.')}</div>` )
		return
	}
	
	// Build the working set for the current scope
	workingBookmarks = computeScopeBookmarks( bookmarkData )
	
	// Strip 'broken' from the working set locally so re-runs start clean
	// (in scope modes the server is untouched, so out-of-scope tags survive)
	for( let b of workingBookmarks ) {
		
		if( b.tags ) {
			
			b.tags = b.tags.filter( t => t !== 'broken' )
		}
	}
	
	if( workingBookmarks.length === 0 ) {
		
		$('#status').html( `<div class="summary">${i18n.t('checkbroken:error.noscope', 'No bookmarks to check in the current scope.')}</div>` )
		
		//note(dgmid): re-show Start so the user can adjust the scope (e.g. tick
		//"include subfolders") and try again without reopening the modal
		$('#btn-start').show()
		$('#btn-close').text( i18n.t('checkbroken:button.close', 'Close') )
		return
	}
	
	total 			= workingBookmarks.length
	checked 		= 0
	nextIndex 		= 0
	inFlight 		= 0
	brokenItems 	= []
	runActive 		= true
	runFinished 	= false
	paused 			= false
	allowClose 		= false
	
	$('#btn-start').hide()
	$('#btn-close').text( i18n.t('checkbroken:button.cancel', 'Cancel') )
	$('#status').html( `<div>${i18n.t('checkbroken:status.starting', 'Checking {{total}} bookmarks…', {total: total})}</div>` )
	$('#progress-bar').show()
	
	// Start concurrent workers
	for( let w = 0; w < CONCURRENCY; w++ ) pump()
}



//note(dgmid): close / cancel — if a run is in progress, show the honest summary
//instead of silently dropping the work: the user can continue, tag the broken
//links found so far, or close without saving anything.

function requestClose() {
	
	if( !runActive || runFinished ) {
		
		allowClose = true
		closeModal()
		return
	}
	
	// Mid-run → pause and show the summary
	paused = true
	
	$('#progress-bar').hide()
	$('#interrupt-panel').show()
	
	$('#interrupt-text').text(
		i18n.t('checkbroken:interrupt.text', '{{checked}} of {{total}} bookmarks checked — {{broken}} broken found (not yet tagged).', {
			checked: checked,
			total: total,
			broken: brokenItems.length
		})
	)
	
	$('#btn-tag-now').text(
		i18n.t('checkbroken:button.tagnow', 'Tag {{count}} broken now', {count: brokenItems.length})
	)
	$('#btn-tag-now').prop( 'disabled', brokenItems.length === 0 )
}



//note(dgmid): block raw window closes (Cmd+W / Cmd+Q) while a run is active, so
//the user always gets the summary instead of losing the run silently.

window.onbeforeunload = function( e ) {
	
	if( runActive && !runFinished && !allowClose ) {
		
		e.returnValue = false
		
		//note(dgmid): show the summary instead of silently cancelling the close
		requestClose()
		
		return false
	}
}



$(document).ready(function() {
	
	setupScope()
	
	$('#btn-start').click( function() {
		
		runCheck()
	})
	
	$('#btn-close').click( function() {
		
		requestClose()
	})
	
	//note(dgmid): continue the interrupted check (restart up to CONCURRENCY workers)
	$('#btn-resume').click( function() {
		
		paused = false
		$('#interrupt-panel').hide()
		$('#progress-bar').show()
		
		let n = Math.max( 0, CONCURRENCY - inFlight )
		for( let w = 0; w < n; w++ ) pump()
	})
	
	//note(dgmid): tag the broken links found so far, then let the user close
	$('#btn-tag-now').click( function() {
		
		if( brokenItems.length === 0 ) return
		
		if( degradedMode ) {
			
			//note(dgmid): server unreachable — tags can't be saved; show the honest notice
			runActive 	= false
			runFinished = true
			
			$('#interrupt-panel').hide()
			$('#btn-close').text( i18n.t('checkbroken:button.close', 'Close') )
			
			showBrokenList( brokenItems )
			$('#status').html( `<div class="summary">${i18n.t('checkbroken:degraded.note', 'Server unreachable or session rejected — broken links will be detected but NOT saved to the server.')}</div>` )
			return
		}
		
		runActive 	= false
		runFinished = true
		
		$('#interrupt-panel').hide()
		$('#btn-close').text( i18n.t('checkbroken:button.close', 'Close') )
		
		showBrokenList( brokenItems )
		
		$('#status').html( `<div>${i18n.t('checkbroken:status.tagging', 'Tagging broken links…', {tagged: 0, total: brokenItems.length})}</div>` )
		
		tagBroken( brokenItems ).then( () => {
			
			$('#status').html( `<div class="summary">${i18n.t('checkbroken:summary.done', 'Done! {{count}} bookmark(s) tagged as "broken".', {count: brokenItems.length})}</div>` )
			
			// Refresh the main window to show updated tags and icons
			ipc.send( 'refresh', 'refresh' )
		})
	})
	
	//note(dgmid): close without touching the server — nothing was changed
	$('#btn-close-no-save').click( function() {
		
		allowClose = true
		closeModal()
	})
	
	//note(dgmid): folder mode — toggling include-subfolders recomputes the count
	$('#chk-include-subfolders').on( 'change', function() {
		
		if( scopeMode === 'folder' ) refreshFolderCount()
	})
	
	// Show footer immediately so user can start or close at any time
	$('#footer').show()
})
