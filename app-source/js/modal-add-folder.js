'use strict'

const i18n 			= require( './i18n.min' )

// Polyfill: make electron-store work in renderer
try {
	const electron = require( 'electron' )
	const remote = require( '@electron/remote' )
	if( !electron.app ) electron.app = remote.app
} catch( e ) {}

const ipc 			= require( 'electron' ).ipcRenderer

const Store 		= require( 'electron-store' )
const store 		= new Store()
const Mousetrap 	= require( 'mousetrap' )

const $ 			= require( 'jquery' )
const jqueryI18next = require( 'jquery-i18next' )

jqueryI18next.init(i18n, $)
const log			= require( 'electron-log' )
const fetch			= require( './fetch.min' )
const serialize		= require( './serialize.min' )
const folderList	= require( './folder-list.min' )

let folders 		= store.get( 'folders' ) || [],
	urlParams 		= new URLSearchParams( location.search ),
	currentFolder 	= urlParams.get('folder')



//note(dgmid): log exceptions

window.onerror = function( error, url, line ) {
	
	ipc.send( 'error-in-render', {error, url, line} )
}



//note(dgmid): set lang & localize strings

$('html').attr('lang', i18n.language)
$('header').localize()
$('label').localize()
$('input').localize()
$('button').localize()


//note(dgmid): register kbd shortcut

Mousetrap.bind('command+.', function() {
	
	closeModal()
})


//note(dgmid): close modal

function closeModal() {
	
	ipc.send( 'close-current-window' )
}



$(document).ready(function() {
	
	//note(dgmid): Home first, then the rest indented as a tree
	
	let options = [ {
		"id": -1,
		"text": i18n.t( 'addfolder:select.option.home', 'Home' ),
		"depth": 0
	} ]
	
	for( let node of folderList.buildHierarchyList( folders ) ) {
		
		options.push( {
			"id": node.id,
			"text": node.text,
			"depth": node.depth
		} )
	}
	
	for( let option of options ) {
		
		let selected = ''
		
		if( option.id == currentFolder ) selected = ' selected';
		
		let indent = '\u00A0\u00A0'.repeat( option.depth )
		
		$('#parent_folder').append( `<option value="${option.id}"${selected}>${indent}${option.text}</option>` )
	}
	
	
	//note(dgmid): cancel modal
	
	$('#cancel').click( function() {
		
		closeModal()
	})
	
	
	//note(dgmid): update data
	
	$('#modal-form').submit( function( e ) {
		
		e.preventDefault()
		
		let data = serialize.serialize({
			
			'title': $('input[name="title"]').val(),
			'parent_folder': $('select[name="parent_folder"]').val()
		})
		
		fetch.bookmarksApi( 'addfolder', '', data, function() {
			
			ipc.send('refresh', 'refresh')
			closeModal()
		})
	})
})
