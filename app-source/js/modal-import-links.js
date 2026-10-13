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

const Store = require( 'electron-store' )

let store
try {
	store = new Store()
} catch( e ) {
	store = { get: () => null, set: () => {} }
}

jqueryI18next.init( i18n, $ )
require( 'select2' )( $ )

const fetchApi 		= require( './fetch.min' )
const serialize 	= require( './serialize.min' )
const extractor 	= require( './link-extract.min' )
const folderList 	= require( './folder-list.min' )



//note(dgmid): log exceptions

window.onerror = function( error, url, line ) {

	ipcRenderer.send( 'error-in-render', {error, url, line} )
}



//note(dgmid): set lang & localize strings

$('html').attr('lang', i18n.language)
$('[data-i18n]').localize()



//note(dgmid): close modal

function closeModal() {

	ipcRenderer.send( 'close-current-window' )
}



//note(dgmid): the three steps of the window — paste, review, choose the folder

let step 		= 'input',
	extracted 	= { links: [], images: [], ignored: [], found: 0 },
	saving 		= false

function setStep( next ) {

	step = next

	$('#step-input, #step-preview, #step-save').hide()
	$('#step-' + next).show()

	//note(dgmid): the destination picker only belongs to the 'save' step. Hide (and
	//show) it as a block: hiding the bare <select> would leave select2's own box on
	//screen, since the widget lives next to the field, not inside it.
	$('#dest-block').toggle( next === 'save' )

	$('#btn-extract, #btn-choose, #btn-save, #btn-back, #btn-close').hide()

	if( next === 'input' ) {

		$('#btn-extract').show()

	} else if( next === 'preview' ) {

		$('#btn-back, #btn-choose').show()

	} else if( next === 'save' ) {

		$('#btn-back, #btn-save').show()

	} else if( next === 'done' ) {

		$('#btn-close').show()
	}
}



//note(dgmid): destination folders — built with the shared folder-list helper, so the
//list is the same hierarchy, with the same locale-aware sibling order, every other
//picker in the app shows. select2 is what makes a long list bearable: it replaces the
//native macOS menu (which drops the whole, always-expanded tree on screen) with a
//dropdown you can type into.

let pickerReady = false

function buildDestinations() {

	let folders 	= store.get( 'folders' ) || [],
		$sel 		= $( '#dest-folder' ).empty()

	$sel.append( $( '<option>', {
		value: '-1',
		text: i18n.t( 'importlinks:label.home', 'Home' ),
		'data-depth': 0
	}))

	for( let node of folderList.buildHierarchyList( folders ) ) {

		$sel.append( $( '<option>', {
			value: node.id,
			text: node.text,
			'data-depth': node.depth
		}))
	}
}

function initDestinationPicker() {

	if( pickerReady ) return

	pickerReady = true

	buildDestinations()

	$( '#dest-folder' ).select2({

		theme: 'custom',
		width: '100%',
		language: {
			noResults: function() { return i18n.t( 'importlinks:select.noresults', 'No folder matches.' ) }
		},
		//note(dgmid): indent folder options by depth so the dropdown reads as a tree
		templateResult: function( data ) {

			if( !data.element ) return data.text

			let depth = parseInt( $( data.element ).data( 'depth' ) || 0, 10 )

			return $( '<span>' ).css( 'padding-left', ( depth * 14 ) + 'px' ).text( data.text )
		}
	})
}



//note(dgmid): one row per link — built with jQuery (never with HTML strings) so a
//title coming from the pasted text can never break the markup

function renderList( $ul, items, checked ) {

	$ul.empty()

	for( let item of items ) {

		let $box = $( '<input>', { type: 'checkbox' } )

		$box.prop( 'checked', checked )
		$box.data( 'item', item )

		let $label = $( '<label>' ).append(
			$box,
			$( '<span>', { 'class': 'pick-title', text: item.title } ),
			$( '<span>', { 'class': 'pick-url', text: item.url } )
		)

		$ul.append( $( '<li>' ).append( $label ) )
	}
}

function selectedItems() {

	let items = []

	$('#links-list input[type="checkbox"], #images-list input[type="checkbox"]').each( function() {

		if( !this.checked ) return

		let item = $( this ).data( 'item' )

		if( item ) items.push( item )
	})

	return items
}



//note(dgmid): extract → preview. Nothing is sent anywhere at this point.

function runExtract() {

	extracted = extractor.extractLinks( $( '#source' ).val() )

	let total = extracted.links.length

	if( !total && !extracted.images.length ) {

		$('#status').text( i18n.t( 'importlinks:note.none', 'No links were found in that text.' ) )
		return
	}

	$('#status').text( '' )

	renderList( $( '#links-list' ), extracted.links, true )

	$('#links-title').text(
		i18n.t( 'importlinks:section.links', '{{count}} link(s) found', { count: extracted.links.length } )
	)

	if( extracted.images.length ) {

		renderList( $( '#images-list' ), extracted.images, false )

		$('#images-title').text(
			i18n.t( 'importlinks:section.images', 'Possible images — not selected ({{count}})', { count: extracted.images.length } )
		)

		$('#images-block').show()

	} else {

		$('#images-block').hide()
	}

	if( extracted.ignored.length ) {

		$('#ignored-note').text(
			i18n.t( 'importlinks:note.ignored', '{{count}} image/media link(s) ignored (X/Twitter, Reddit, YouTube thumbnails…).', { count: extracted.ignored.length } )
		)

	} else {

		$('#ignored-note').text( '' )
	}

	$('#preview-summary').text(
		i18n.t( 'importlinks:section.links', '{{count}} link(s) found', { count: extracted.links.length } )
	)

	setStep( 'preview' )
}



//note(dgmid): preview → destination

function runChoose() {

	let items = selectedItems()

	if( !items.length ) {

		$('#status').text( i18n.t( 'importlinks:done.none_selected', 'No links are selected.' ) )
		return
	}

	$('#status').text( '' )

	//note(dgmid): show the step first, then build the picker — select2 measures its
	//box when it is created, and a hidden field measures zero
	setStep( 'save' )

	initDestinationPicker()

	$( '#dest-folder' ).val( '-1' ).trigger( 'change' )

	$('#save-summary').text(
		i18n.t( 'importlinks:section.links', '{{count}} link(s) found', { count: items.length } )
	)

	$('#btn-save').text(
		i18n.t( 'importlinks:button.save_count', 'Save {{count}} bookmark(s)', { count: items.length } )
	)
}



//note(dgmid): save — one 'add' call per bookmark, sequentially, so a large paste
//does not open a window full of parallel requests. Same API call and favicon
//hand-off the single "Add Bookmark" modal and the file import already use.

function runSave() {

	if( saving ) return

	let items = selectedItems()

	if( !items.length ) {

		$('#status').text( i18n.t( 'importlinks:done.none_selected', 'No links are selected.' ) )
		return
	}

	let destId = parseInt( $( '#dest-folder' ).val(), 10 )

	if( isNaN( destId ) ) destId = -1

	saving = true

	$('#btn-save, #btn-back').prop( 'disabled', true )

	let index 	= 0,
		ok 		= 0,
		failed 	= 0

	function next() {

		if( index >= items.length ) {

			finish()
			return
		}

		let item = items[index]

		$('#status').text(
			i18n.t( 'importlinks:progress.saving', 'Saving {{done}}/{{total}}…', { done: index + 1, total: items.length } )
		)

		let data = serialize.serialize({ url: item.url, title: item.title }) + '&folders[]=' + destId

		fetchApi.bookmarksApi( 'add', '', data, function( message ) {

			if( message ) {

				ok++

				try {

					let returned = JSON.parse( message )
					ipcRenderer.send( 'update-favicon', returned['item'] )

				} catch( e ) {}

			} else {

				failed++
			}

			index++

			setTimeout( next, 120 )
		})
	}

	function finish() {

		saving = false

		$('#btn-save, #btn-back').prop( 'disabled', false )

		$('#status').text( '' )

		//note(dgmid): the bookmarks are on the server now — refresh the main window
		ipcRenderer.send( 'refresh', 'refresh' )

		$('#save-summary').text(
			failed > 0
				? i18n.t( 'importlinks:done.partial', 'Imported {{ok}} bookmark(s); {{failed}} failed.', { ok: ok, failed: failed } )
				: i18n.t( 'importlinks:done.saved', 'Imported {{count}} bookmark(s).', { count: ok } )
		)

		setStep( 'done' )
	}

	next()
}



$(document).ready( function() {

	$('#btn-extract').click( function() {

		runExtract()
	})

	$('#btn-back').click( function() {

		$('#status').text( '' )

		setStep( step === 'save' ? 'preview' : 'input' )
	})

	$('#btn-choose').click( function() {

		runChoose()
	})

	$('#btn-save').click( function() {

		runSave()
	})

	$('#btn-all').click( function() {

		$('#links-list input[type="checkbox"], #images-list input[type="checkbox"]').prop( 'checked', true )
	})

	$('#btn-none').click( function() {

		$('#links-list input[type="checkbox"], #images-list input[type="checkbox"]').prop( 'checked', false )
	})

	$('#btn-close, #btn-cancel').click( function() {

		if( saving ) return

		closeModal()
	})

	setStep( 'input' )
})
