'use strict'

const i18n		= require( './i18n.min' )

const fs 		= require( 'fs-extra' )
const path 		= require('path')
const Store		= require( 'electron-store' )
const store		= new Store()
const $			= require( 'jquery' )
const log		= require( 'electron-log' )
const dt			= require( 'datatables.net' )( window, $ )
const keytable	= require( 'datatables.net-keytable' )( window, $ )

require( 'datatables.net-responsive' )( window, $ )
require( 'datatables.net-select' )( window, $ )



//note(dgmid): natural (locale-aware) string ordering for the Title column — plain
//code-point compares sort "Álava" after "zoo" and treat "a" and "A" inconsistently.
//Registered once as a DataTables type; the Title column declares type 'locale' below.

if( !$.fn.dataTable.ext.type.order['locale-asc'] ) {
	
	const _collator = ( typeof Intl !== 'undefined' && Intl.Collator )
		? new Intl.Collator( undefined, { numeric: true, sensitivity: 'base' } )
		: null
	
	const _compare = ( a, b ) => {
		
		if( _collator ) return _collator.compare( a, b )
		
		a = String( a ).toLowerCase()
		b = String( b ).toLowerCase()
		
		return ( a > b ) ? 1 : ( ( a < b ) ? -1 : 0 )
	}
	
	$.fn.dataTable.ext.type.order['locale-asc']		= function( a, b ) { return _compare( a, b ) }
	$.fn.dataTable.ext.type.order['locale-desc']	= function( a, b ) { return _compare( b, a ) }
}



$.fn.dataTable.render.ellipsis = function ( cutoff, wordbreak, escapeHtml ) {
	
	var esc = function ( t ) {
		return t
		.replace( /&/g, '&amp;' )
		.replace( /</g, '&lt;' )
		.replace( />/g, '&gt;' )
		.replace( /"/g, '&quot;' )
	}

	return function ( d, type, row ) {
	
		if ( type !== 'display' ) {
			
			return d
		}
	
		if ( typeof d !== 'number' && typeof d !== 'string' ) {
			
			return d
		}
	
		d = d.toString()
	
		if ( d.length <= cutoff ) {
			
			return d
		}
	
		var shortened = d.substr(0, cutoff-1)
	
		if ( wordbreak ) {
			
			shortened = shortened.replace(/\s([^\s]*)$/, '')
		}
	
		if ( escapeHtml ) {
			
			shortened = esc( shortened )
		}
	
		return '<span class="ellipsis" title="'+esc(d)+'">'+shortened+'&#8230;</span>'
	}
}



module.exports.bookmarkTable = $('#bookmarks').DataTable({
	
	responsive: true,
	responsive: {
		details: false
	},
	select: {
		style: 'os',
		selector: 'td:not(.details-control)',
		info: true
	},
	keys: {
		tabIndex: 1,
		blurable: true,
		keys: [ 	32, // space
					38, // up
					40  // down
		]
	},
	
	scrollY: 	'calc(100vh - 59px)', // window height - header - footer
	paging: 	false,
	dom: 'ltipr', // hide default search field
	rowId:
		function(column) {
			return 'row_' + column[0] // create unique row id form json ids
		},
	'order': [[ 5, 'desc' ]],
	//note(dgmid): make rows draggable so bookmarks can be dropped onto a folder card
	//in the main panel's folder strip. Runs once per row at creation (not on every draw).
	createdRow: function( row ) {
		
		row.setAttribute( 'draggable', 'true' )
	},
	columnDefs:
		[
			{
				title: 'ID',
				targets: [ 0 ],
				visible: false,
				searchable: false
			},
			{
				title: `<button id="toggle-info-panel" title="${i18n.t('bookmarktable:header.details', 'Details')}"></button>`,
				responsivePriority: 1,
				targets: [ 1 ],
				className: 'details-control',
				orderable: false,
				data: null,
				defaultContent: '',
				width: '35px'
			},
			{
				title: i18n.t('bookmarktable:header.title', 'Title'),
				render: $.fn.dataTable.render.ellipsis( 45, true, true ),
				responsivePriority: 1,
				targets: [ 2 ],
				type: 'locale',
				width: '99%'
			},
			{
				title: i18n.t('bookmarktable:header.description', 'Description'),
				render: $.fn.dataTable.render.ellipsis( 45, true, true ),
				responsivePriority: 10000,
				targets: [ 3 ],
				visible: store.get('tableColumns.description')
			},
			{
				title: i18n.t('bookmarktable:header.url', 'Url'),
				render: $.fn.dataTable.render.ellipsis( 45, true, true ),
				responsivePriority: 10001,
				targets: [ 4 ],
				visible: store.get('tableColumns.url')
			},
			{
				title: 'unix added',
				targets: [ 5 ],
				visible: false
			},
			{
				title: i18n.t('bookmarktable:header.created', 'Created'),
				responsivePriority: 10003,
				targets: [ 6 ],
				visible: store.get('tableColumns.created'),
				searchable: false,
				iDataSort: 5
			},
			{
				title: 'unix modified',
				targets: [ 7 ],
				visible: false
			},
			{
				title: i18n.t('bookmarktable:header.modified', 'Modified'),
				responsivePriority: 10002,
				targets: [ 8 ],
				visible: store.get('tableColumns.modified'),
				searchable: false,
				iDataSort: 7
			},
			{
				targets: [ 6, 8 ],
				className: 'date-column',
				width: '135px'
			},
			{
				title: 'folder id',
				targets: [ 9 ],
				visible: false
			},
			{
				title: i18n.t('bookmarktable:header.folders', 'Folders'),
				className: 'folders-column',
				responsivePriority: 10004,
				targets: [ 10 ],
				visible: store.get('tableColumns.folders'),
			},
			{
				title: i18n.t('bookmarktable:header.tags', 'Tags'),
				className: 'tags-column padded-right',
				responsivePriority: 2,
				targets: [ 11 ],
				visible: store.get('tableColumns.tags'),
				width: '50px',
			}
		],
	
	language: {
		emptyTable: i18n.t('bookmarktable:footer.nodata', 'No data available'),
		zeroRecords: i18n.t('bookmarktable:footer.zero', '<span class="text">No matching Bookmarks were found</span>'),
		info: i18n.t('bookmarktable:footer.info', '<span class="text">Showing </span><b>_TOTAL_</b><span class="text"> Bookmarks</span>'),
		infoEmpty: i18n.t('bookmarktable:footer.empty', 'Showing <b>0</b><span class="text"> to 0 of 0 Bookmarks</span>'),
		infoFiltered: i18n.t('bookmarktable:footer.filtered', '<span class="filtered">(filtered from _MAX_ Bookmarks)</span>')
	}
})



//note(dgmid): Hook into DataTables 'select'/'deselect' events to keep
//              the internal _select.selected[] array in sync. This ensures
//              that aoRowCreatedCallback re-applies the 'selected' class
//              if any redraw occurs (e.g. scrollY virtualization, KeyTable
//              focus change). Without this sync, programmatic .select() calls
//              would set aoData[idx]._select_selected but NOT the redraw-safe
//              flag _select.selected[idx].

let _bookmarkTable = $('#bookmarks').DataTable()

_bookmarkTable.on('select', function(e, dt, type, indexes) {
	
	if( type === 'row' ) {
		
		indexes.forEach(function(idx) {
			
			// Sync _select.selected so aoRowCreatedCallback re-applies class on redraw
			try {
				let settings = dt.settings()[0]
				if( settings && settings._select ) {
					settings._select.selected[ idx ] = true
				}
			} catch(e2) {}
			
			let node = dt.row(idx).node()
			
			if( node ) {
				
				$(node).addClass('selected')
				
				// INLINE STYLE FALLBACK: Paint <td> backgrounds directly.
				// The bundled CSS for tr.selected td requires .stripe class on
				// the table, which may not be present in scrollY mode. Inline
				// styles on <td> are the highest-specificity approach and don't
				// depend on CSS cascade or variable resolution.
				$(node).children('td').css({
					'background-color': '#005d6e',
					'color': '#fff'
				})
				

			}
		})
	}
})

_bookmarkTable.on('deselect', function(e, dt, type, indexes) {
	
	if( type === 'row' ) {
		
		indexes.forEach(function(idx) {
			
			// Sync _select.selected for redraw safety
			try {
				let settings = dt.settings()[0]
				if( settings && settings._select && settings._select.selected ) {
					delete settings._select.selected[ idx ]
				}
			} catch(e2) {}
			
			let node = dt.row(idx).node()
			
			if( node ) {
				
				$(node).removeClass('selected')
				
				// Remove inline style fallback
				$(node).children('td').css({
					'background-color': '',
					'color': ''
				})
			}
		})
	}
})


//note(dgmid): Track anchor, current row, and KeyTable's focus position.
//              _shiftAnchor = visual position (anchor for Shift+Arrow, 0-based)
//              _currentRow  = visual position (where we are after each arrow)
//              _focusedRow  = data index (tracks where KeyTable moved focus)
//
// CRITICAL: DataTables has TWO index systems when the table is sorted:
//   - DATA index  = position in the original data array
//   - VISUAL index = position on screen (0 = first visible row)
// table.cell(node).index().row returns the DATA index. But arrow-key
// navigation must use VISUAL positions (+1/-1) and then convert to
// DATA indexes for .select() calls.

let _shiftAnchor = null,
	_currentRow  = null,
	_focusedRow  = null

$('#bookmarks tbody').on('mousedown', 'td:not(.details-control)', function(e) {
	
	// Only set anchor on plain click (no modifier keys)
	if( !e.shiftKey && !e.ctrlKey && !e.metaKey ) {
		
		let table	= $('#bookmarks').DataTable(),
			cell	= table.cell( this )
		
		if( cell ) {
			
			let dataIdx	= cell.index().row
			
			// Convert data index to visual position (0-based position on screen)
			let visualIdx	= table.rows({ order: 'current' }).indexes().indexOf( dataIdx )
			
			_shiftAnchor = visualIdx
			_currentRow  = visualIdx
			_focusedRow  = dataIdx
		}
	}
})


//note(dgmid): Track KeyTable's focus movement via its key-focus.dt event.
//              This fires DURING KeyTable's keydown processing, BEFORE the
//              event bubbles to our document-level keydown handler.

$('#bookmarks').on('key-focus.dt', function(e, datatable, cell) {
	
	if( cell && cell.index ) {
		
		_focusedRow = cell.index().row
	}
})


//note(dgmid): Keyboard range selection — Shift+Arrow (up/down).
//              Uses VISUAL positions for +1/-1 navigation, then converts
//              to DATA indexes for .select() calls. This ensures that
//              navigation follows the on-screen order even when the
//              table is sorted by date.

$(document).on('keydown', function(e) {
	
	// Only handle Up/Down arrows
	if( e.which !== 38 && e.which !== 40 ) return
	
	// Must have a starting row
	if( _currentRow === null || _focusedRow === null ) return
	
	let table		= $('#bookmarks').DataTable(),
	    direction	= e.which === 40 ? 1 : -1,
	    nextVisPos	= _currentRow + direction
	
	// Get all data indexes in CURRENT visual order (sorted by date desc)
	let visualIdxArray	= table.rows({ order: 'current' }).indexes().toArray(),
	    totalRows		= visualIdxArray.length
	
	if( nextVisPos < 0 || nextVisPos >= totalRows ) return
	
	e.preventDefault()
	
	// Convert visual position to data index for .select()
	let nextDataIdx = visualIdxArray[ nextVisPos ]
	
	if( e.shiftKey ) {
		
		// Shift+Arrow: extend selection from anchor (visual) to nextVisPos
		if( _shiftAnchor === null ) {
			_shiftAnchor = _currentRow
		}
		
		let startVis	= Math.min( _shiftAnchor, nextVisPos ),
		    endVis		= Math.max( _shiftAnchor, nextVisPos ),
		    dataIdxs	= []
		
		for( let v = startVis; v <= endVis; v++ ) {
			dataIdxs.push( visualIdxArray[ v ] )
		}
		
		table.rows().deselect()
		table.rows( dataIdxs ).select()
		
	} else {
		
		// Arrow alone (no Shift): select only the row at nextVisPos
		table.rows().deselect()
		table.row( nextDataIdx ).select()
		
		_shiftAnchor = nextVisPos
	}
	
	_currentRow = nextVisPos
	_focusedRow = nextDataIdx
	
	// Move KeyTable's focus to the newly selected row (visible column 2 = title)
	// so the focus indicator follows our predictable contiguous selection
	// instead of KeyTable's erratic internal focus movement.
	// Use the DATA index for .cell() since KeyTable works with data indexes.
	try {
		table.cell( nextDataIdx, 2 ).focus()
	} catch( _e ) {}
})


module.exports.detailsTable = function( data ) {
	
	let desc = ( data[3] == '' ? '⋯' : data[3] )
	
	return `<div class="details-panel">
	<div class="inner">
		<div class="row">
			<div class="label">${i18n.t('bookmarktable:header.url', 'Url')}:</div>
			<div class="value nowrap"><a id="url_${data[0]}" href="${data[4]}" title="${data[2]}"><img class="favicon" src="${getFavicon(data[0])}" width="16" height="16">&nbsp;${data[4]}</a></div>
		</div>
		
		<div class="row">
			<div class="label">${i18n.t('bookmarktable:header.title', 'Title')}:</div>
			<div class="value wrap">${data[2]}</div>
		</div>
		
		<div class="row">
			<div class="label">${i18n.t('bookmarktable:header.description', 'Description')}:</div>
			<div class="value wrap">${desc}</div>
		</div>
		
		<div class="row">
			<div class="label">${i18n.t('bookmarktable:header.created', 'Created')}:</div>
			<div class="value">${data[6]}</div>
		</div>
		
		<div class="row">
			<div class="label">${i18n.t('bookmarktable:header.modified', 'Modified')}:</div>
			<div class="value">${data[8]}</div>
		</div>
		
		<div class="row">
			<div class="label">${i18n.t('bookmarktable:header.folders', 'Folders')}:</div>
			<div class="value">${data[10]}</div>
		</div>
		
		<div class="row">
			<div class="label">${i18n.t('bookmarktable:header.tags', 'Tags')}:</div>
			<div class="value">${data[11]}</div>
		</div>
		
		<div class="buttons">
			<button class="info-edit ui-button small" data-id="${data[0]}">${i18n.t('menu:bookmarks.edit', 'Edit Bookmark…')}</button>
			<button class="info-delete ui-button small" data-id="${data[0]}">${i18n.t('menu:bookmarks.delete', 'Delete Bookmark…')}</button>
		</div>
	</div>
</div>`
}



function getFavicon( id ) {
	
	let dir = store.get( 'dirPath' ),
		res = ( matchMedia( '(-webkit-min-device-pixel-ratio: 2), (min-device-pixel-ratio: 2), (min-resolution: 192dpi)' ).matches ? '@2x' : '' )
	
	if( fs.pathExistsSync( `${dir}/favicons/${id}${res}.png` ) ) {
		
		return `${dir}/favicons/${id}${res}.png`
		
	} else {
		
		let theme = ( $('html').attr('data-theme') === 'dark' ) ? 'dark-'  : ''
		
		return path.join(__dirname, `../assets/png/${theme}faviconTemplate${res}.png`) 
	}
}
