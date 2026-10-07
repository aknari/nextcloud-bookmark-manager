'use strict'

const i18n = require( './i18n.min' )

// Polyfill: make electron-store work in renderer
try {
	const electron = require( 'electron' )
	const remote = require( '@electron/remote' )
	if( !electron.app ) electron.app = remote.app
} catch( e ) {}

const { ipcRenderer } = require( 'electron' )
const $ = require( 'jquery' )
const jqueryI18next = require( 'jquery-i18next' )

jqueryI18next.init( i18n, $ )

//note(dgmid): the shared module — the same one the auto-organize final step uses.
//This window is just a thin shell around it: scan → confirmation dialog → delete.
const cleanup = require( './cleanup-empty.min' )



//note(dgmid): log exceptions

window.onerror = function( error, url, line ) {
	
	ipcRenderer.send( 'error-in-render', {error, url, line} )
}



//note(dgmid): set lang & localize strings

$('html').attr('lang', i18n.language)
$('header').localize()
$('button').localize()



//note(dgmid): close modal

function closeModal() {
	
	ipcRenderer.send( 'close-current-window' )
}



//note(dgmid): run the cleanup once — the module fetches the folder tree, lists the
//candidates and asks for confirmation before deleting anything.

let running = false

function runCleanup() {
	
	if( running ) return
	
	running = true
	
	$('#btn-start').hide()
	$('#hint').hide()
	$('#progress-bar').show()
	$('#status').text( i18n.t( 'cleanup:progress.scanning', 'Scanning for empty folders…' ) )
	
	cleanup.cleanupEmptyFolders( function( result ) {
		
		running = false
		
		$('#progress-bar').hide()
		
		//note(dgmid): the module reports a human-readable error when it could not run
		if( result && result.error ) {
			
			$('#status').text( result.error )
			$('#btn-start').show()
			return
		}
		
		let deleted = ( result && result.deleted ) ? result.deleted : 0
		
		if( deleted > 0 ) {
			
			$('#status').text(
				i18n.t( 'cleanup:done.removed', 'Done! {{count}} empty folder(s) deleted.', { count: deleted } )
			)
			
			//note(dgmid): folders were removed on the server — refresh the main window
			ipcRenderer.send( 'refresh', 'refresh-bookmarks' )
			
		} else {
			
			$('#status').text(
				i18n.t( 'cleanup:done.none', 'No empty folders were found.' )
			)
		}
		
		$('#btn-close').text( i18n.t( 'cleanup:button.close', 'Close' ) )
	})
}



$(document).ready(function() {
	
	$('#footer').show()
	
	$('#btn-start').click( function() {
		
		runCleanup()
	})
	
	$('#btn-close').click( function() {
		
		closeModal()
	})
})
