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
const log			= require( 'electron-log' )



let bookmarkFile = new Store({
	
	name: 'bookmarks',
	defaults: {
		data: null
	}
})



//note(dgmid): degraded (read-only) mode — activated when the server rejects our
//session (401/403). The app keeps working from the local mirror, writes are
//blocked with ONE clear notice (instead of an error box per call), and the flag
//is cleared automatically on the first successful authenticated call.

let degradedNotified = false

function setDegraded( value ) {
	
	//note(dgmid): idempotent — avoid repeated store writes + IPC on bulk 401s
	if( !!store.get( '_serverDegraded' ) === value ) return
	
	store.set( '_serverDegraded', value )
	ipcRenderer.send( 'server-status-changed', { degraded: value } )
}



const path = '/index.php/apps/bookmarks/public/rest/v2'
const calltype = {
	
	'all': {
		'method': 'GET',
		'url': '/bookmark?page=-1'	
	},
	'single': {
		'method': 'GET',
		'url': '/bookmark/'
	},
	'add': {
		'method': 'POST',
		'url': '/bookmark?'
	},
	'modify': {
		'method': 'PUT',
		'url': '/bookmark/',
	},
	'delete': {
		'method': 'DELETE',
		'url': '/bookmark/'
	},
	'modifytag': {
		'method': 'POST',
		'url': '/tag?'
	},
	'deletetag': {
		'method': 'DELETE',
		'url': '/tag/'
	},
	'folders': {
		'method': 'GET',
		'url': '/folder'
	},
	'addfolder': {
		'method': 'POST',
		'url': '/folder?'
	},
	'renamefolder': {
		'method': 'PUT',
		'url': '/folder/'
	},
	'addtofolder': {
		'method': 'POST',
		'url': '/folder/'
	},
	'deletefromfolder': {
		'method': 'DELETE',
		'url': '/folder/'
	},
	'deletefolder': {
		'method': 'DELETE',
		'url': '/folder/'
	}
}



module.exports.bookmarksApi = function( call, id, data, callback ) {
	
	let server 		= store.get( 'loginCredentials.server' ),
		username 	= store.get( 'loginCredentials.username' ),
		password 	= store.get( 'loginCredentials.password' ),
		degraded	= !!store.get( '_serverDegraded' )
	
	if( !server || !username || !password ) {
		
		log.warn( 'fetch: credentials missing — aborting call' )
		
		//note(dgmid): always settle the callback — bulk loops (auto-organize withdrawals,
		//check-broken-links) hang forever waiting for a response that never comes
		if( callback ) callback( null )
		
		return
	}
	
	//note(dgmid): degraded (read-only) mode — the server rejected our session.
	//Writes are blocked up front with ONE clear notice; reads are allowed through
	//(a successful authenticated call clears the flag automatically).
	if( degraded && calltype[call]['method'] !== 'GET' ) {
		
		log.warn( `fetch: blocked '${call}' — server in degraded mode` )
		
		if( !degradedNotified ) {
			
			degradedNotified = true
			
			ipcRenderer.send( 'show-error-box', {
				title: i18n.t( 'app:degraded.title', 'Offline mode' ),
				content: i18n.t( 'app:degraded.writeblocked', 'The server is unreachable or has rejected the session, so changes are not being applied. Your bookmarks are safe in the local copy.' )
			})
		}
		
		if( callback ) callback( null )
		return
	}
	
	let init = {
		
		method: calltype[call]['method'],
		headers: {
			'Authorization': 'Basic ' + btoa( username + ':' + password ),
			'Content-Type': 'application/json'
		},
		cache: 'no-cache'
	}
	
	let url = `${path}${calltype[call]['url']}${id}${data}`
	
	const requestUrl = server + url
	
	// Use browser fetch() — CORS restrictions are disabled via webSecurity:false in main.js
	fetch( requestUrl, init )
	.then(function(response) {
		
		if(!response.ok) {
			
			log.warn(`fetch error: ${response.status} - ${response.statusText}`)
			let errTxt = parseErrorMessage( response.status )
			
			//note(dgmid): 401/403 = the server rejected our session — enter degraded
			//mode so the UI shows the banner instead of an error box per call
			if( response.status === 401 || response.status === 403 ) {
				
				setDegraded( true )
			}
			
			throw Error( `${response.status} ${errTxt}` )
			
		} else {
		
			// Safety timeout: response.text() can hang on some servers that don't close
			// the connection after sending an empty body (e.g. 204 No Content).
			// This prevents callers (like check-broken-links) from hanging forever.
			let bodyTimeout = setTimeout( () => {}, 0 )
			//note(dgmid): 60s — the 'all' bookmark listing can be tens of MB on large
			//accounts; a 10s body timeout made every full refresh fail on those servers.
			return Promise.race([
				response.text().finally( () => clearTimeout( bodyTimeout ) ),
				new Promise( (_, reject) => {
					bodyTimeout = setTimeout( () => reject( new Error( 'timeout reading response body' ) ), 60000 )
				})
			])
		}
		
	}).then(function(message) {
		
		//note(dgmid): a successful authenticated call means the session works
		//again — leave degraded mode and allow writes
		if( store.get( '_serverDegraded' ) ) setDegraded( false )
		degradedNotified = false
		
		switch( call ) {
			
			case 'all':
				
				let allDoc = JSON.parse(message)
				
				if (allDoc['status'] == 'error') {
					
					ipcRenderer.send('show-error-box', { title: i18n.t('fetch:errorbox.title.json', 'JSON parsing error'), content: i18n.t('fetch:errorbox.content.json', 'An error occured parsing the bookmarks') })
					
					log.error(allDoc['message'])
				
				} else {
					
					callback( allDoc.data )
					bookmarkFile.set('data', allDoc.data)
				}
			break
			
			case 'folders':
				
				let folderDoc = JSON.parse(message)
				let folders = []
				
				function traverseFolders( obj ) {
				
					for( let prop in obj ) {
				
						folders.push({
							"id": parseInt( obj[prop].id, 10 ),
							"text": obj[prop].title,
							"parent_folder": ( obj[prop].parent_folder != null ) ? parseInt( obj[prop].parent_folder, 10 ) : -1
						})
						
						if( typeof obj[prop]=='object' ) {
					
							traverseFolders( obj[prop].children )
						}
					}
				}
				
				traverseFolders( folderDoc.data )
				store.set( 'folders', folders )
				callback()
				
			break
			
			//todo - not needed
			case 'single': callback( message )
			break
			
			default: callback( message )
		}
		
	}).catch(function( error ) {
		
		log.error(error)
		
		//note(dgmid): in degraded mode suppress the per-call error dialogs — the
		//banner already tells the user the server is unreachable
		if( call !== 'modify' && !store.get( '_serverDegraded' ) ) {
			
			ipcRenderer.send('show-error-box', { title: i18n.t('fetch:errorbox.title.error', 'Server error'), content: i18n.t('fetch:errorbox.content.error', 'there was an error retrieving:\n{{- server}}{{- url}}\n\n{{error}}', {server: server, url: url, error: error}) })
		}
		
		// Always call callback so callers don't hang (e.g. Promise.race timeouts in check-broken-links)
		if( callback ) callback( null )
	})
}



//note(dgmid): 'modify' with retries — a single transient network failure (laptop sleep,
//Wi-Fi drop) used to permanently skip the bookmark in bulk loops (auto-organize apply,
//auto-tag apply, repair-titles apply). Retries a few times with backoff before giving up.

module.exports.modifyWithRetry = function( id, data, maxRetries, callback ) {
	
	let attempt = 0,
		settled = false
	
	//note(dgmid): safety watchdog — bookmarksApi can return WITHOUT calling back
	//(e.g. missing credentials), which would otherwise hang the apply loop forever
	let watchdog = setTimeout( function() { finish( null ) }, 30000 )
	
	function finish( response ) {
		
		if( settled ) return
		
		settled = true
		clearTimeout( watchdog )
		callback( response )
	}
	
	function tryOnce() {
		
		//note(dgmid): in degraded mode the server won't accept writes — give up
		//immediately instead of burning through the retries
		if( store.get( '_serverDegraded' ) ) { finish( null ); return }
		
		module.exports.bookmarksApi( 'modify', id, data, function( response ) {
			
			if( response !== null ) { finish( response ); return }
			
			attempt++
			
			if( attempt <= maxRetries ) {
				
				setTimeout( tryOnce, 1500 * attempt )
				
			} else {
				
				finish( null )
			}
		})
	}
	
	tryOnce()
}



function parseErrorMessage( message ) {
	
	let errMsg
	
	switch( message ) {
		
		case 400: errMsg = i18n.t('fetch:dialog.error.message.400', 'Bad Request')
		break
		case 401: errMsg = i18n.t('fetch:dialog.error.message.401', 'Unauthorized')
		break
		case 403: errMsg = i18n.t('fetch:dialog.error.message.403', 'Forbidden')
		break
		case 404: errMsg = i18n.t('fetch:dialog.error.message.404', 'Not Found')
		break
		case 500: errMsg = i18n.t('fetch:dialog.error.message.500', 'Internal Server Error')
		break
		case 501: errMsg = i18n.t('fetch:dialog.error.message.501', 'Not Implemented')
		break
		case 502: errMsg = i18n.t('fetch:dialog.error.message.502', 'Bad Gateway')
		break
		case 503: errMsg = i18n.t('fetch:dialog.error.message.503', 'Service Unavailable')
		break
		case 504: errMsg = i18n.t('fetch:dialog.error.message.504', 'Gateway Timeout')
		break
		
		default: errMsg =  i18n.t('fetch:dialog.error.message.default', 'Unspecified')
	}
	
	return errMsg
}
