'use strict'

const i18n 			= require( './i18n.min' )

// Polyfill: make electron-store work in renderer
try {
	const electron = require( 'electron' )
	const remote = require( '@electron/remote' )
	if( !electron.app ) electron.app = remote.app
} catch( e ) {}

const { ipcRenderer: ipc } = require( 'electron' )

const Store 		= require( 'electron-store' )
const store 		= new Store()
const Mousetrap 	= require( 'mousetrap' )

const $ 			= require( 'jquery' )
const jqueryI18next = require( 'jquery-i18next' )

jqueryI18next.init(i18n, $)
require('select2')($)

const fetch			= require( './fetch.min' )
const serialize		= require( './serialize.min' )
const entities		= require( './entities.min' )
const folderList	= require( './folder-list.min' )

let urlParams 		= new URLSearchParams( location.search ),
	theId 			= urlParams.get('id'),
	tree 			= folderList.buildHierarchyList( store.get( 'folders' ) )



//note(dgmid): log exceptions

window.onerror = function( error, url, line ) {
	
	ipc.send( 'error-in-render', {error, url, line} )
}



//note(dgmid): set lang & localize strings

$('html').attr('lang', i18n.language)
$('header span').localize()
$('label').localize()
$('input').localize()
$('option').localize()
$('button').localize()



//note(dgmid): register kbd shortcut
Mousetrap.bind('command+.', function() {
	
	closeModal()
})



//note(dgmid): populate form

function populateForm( bookmark ) {
	
	if( bookmark['item']['folders'].includes( -1 ) ) {
		
		$('#folders').val( '-1' )
	}
	
	//note(dgmid): Home first, then the rest indented as a tree
	
	$('#folders').append( `<option value="-1" data-depth="0">${i18n.t( 'editbookmark:select.option.home', 'Home' )}</option>` )
	
	for( let node of tree ) {
		
		let selected = ''
		if( bookmark['item']['folders'].includes( node.id ) ) {
			
			selected = ' selected'
		}
		$('#folders').append( `<option value="${node.id}"${selected} data-depth="${node.depth}">${node.text}</option>` )
	}
	
	$('header').append( entities.encode( bookmark['item']['title'] ) )
	$('input[name="url"]').val( bookmark['item']['url'] )
	$('input[name="title"]').val( bookmark['item']['title'] )
	$('textarea[name="description"]').val( bookmark['item']['description'] )
	
	
	//note(dgmid): set any active tags
	
	let activeTags = []
	const allTags = store.get('tags')
	
	for (let singleTag of  allTags) {
		
		if( bookmark['item']['tags'].indexOf( singleTag['text'] ) > -1 ) {
			
			activeTags.push( singleTag['id'] )
		}
	}
	
	$('#tags').val( activeTags )
	$('#tags').trigger( 'change' )
	
}



//note(dgmid): close modal

function closeModal() {
	
	ipc.send( 'close-current-window' )
}



$(document).ready(function() {
	
	$('#folders').select2({
		theme: "custom",
		width: '320px',
		language: {
			noResults:function() { return i18n.t( 'editbookmark:select.noresults', 'No results found' ) }
		},
		//note(dgmid): indent folder options by depth so the dropdown reads as a tree
		templateResult: function( data ) {
			
			if( !data.element ) return data.text
			
			let depth = parseInt( $(data.element).data('depth') || 0, 10 )
			
			return $(`<span style="padding-left:${depth * 14}px">${data.text}</span>`)
		}
	})
	
	$('#tags').select2({
		theme: "custom",
		width: '320px',
		tags: true,
		tokenSeparators: [',',';'],
		data: store.get('tags')
	})
	
	
	fetch.bookmarksApi( 'single', theId, '', function( message ) {
		
		populateForm( JSON.parse( message ) )
	})
	
	
	//note(dgmid): cancel modal
	
	$('#cancel').click( function() {
		
		closeModal()
	})
	
	
	//note(dgmid): update data
	
	$('#modal-form').submit( function( e ) {
		
		e.preventDefault()
		
		let data = '?'
		
		data += serialize.serialize({
	
			'record_id': theId,
			'url': $('input[name="url"]').val(),
			'title': $('input[name="title"]').val(),
			'description': $('textarea[name="description"]').val()
		})
		
		let selectedTags = $('#tags').select2('data')
		
		for (let tag of selectedTags) {
			
			data += '&tags[]=' + encodeURIComponent(tag['text'])
		}
		
		let selectedFolders = $('#folders').select2('data')
		
		for(let folder of selectedFolders) {
			
			data += '&folders[]=' + encodeURIComponent(folder['id'])
		}
		
		fetch.bookmarksApi( 'modify', theId, data, function( response ) {
			
			//note(dgmid): capture the server-assigned lastmodified so the Modified column
			//can refresh instantly. The PUT response is the updated bookmark; if parsing
			//fails (or the field is missing) fall back to "now" — the server just touched it.
			
			let lastmodified = Math.floor( Date.now() / 1000 )
			
			if( response ) {
				
				try {
					
					let doc = JSON.parse( response )
					
					if( doc && doc.item && doc.item.lastmodified ) {
						
						lastmodified = parseInt( doc.item.lastmodified, 10 )
						
					} else if( doc && doc.lastmodified ) {
						
						lastmodified = parseInt( doc.lastmodified, 10 )
					}
					
				} catch( e ) {}
			}
			
			//note(dgmid): pass the edited bookmark back through IPC so the main window
			//can update that single row instantly instead of re-downloading all bookmarks
			ipc.send( 'refresh', {
				action: 'edit-bookmark',
				data: {
					id: parseInt( theId, 10 ),
					url: $('input[name="url"]').val(),
					title: $('input[name="title"]').val(),
					description: $('textarea[name="description"]').val(),
					tags: selectedTags.map( t => t['text'] ),
					folders: selectedFolders.map( f => parseInt( f['id'], 10 ) ),
					lastmodified: lastmodified
				}
			})
			
			closeModal()
		})
	})
})
