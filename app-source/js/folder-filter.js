'use strict'

//note(dgmid): live filter for the sidebar folder tree.
//
//Two things make it behave the way you expect from a tree:
//  - matching is case- AND accent-insensitive ("recopilacion" finds "Recopilación",
//    "NEW" finds "new"), the same way folder-list sorts names.
//  - a folder stays on screen when a match lives inside it, and its branch is opened,
//    so the path to what was found is never hidden.
//
//Both effects are expressed with classes added on top of the tree's own markup
//(.filtered-out / .filtered-open), never by rewriting it: clearing the box removes
//those classes and the tree is exactly as it was — collapse state included — and the
//selection / drag handlers already bound to the rows are left untouched.

const $ = require( 'jquery' )

const HIDDEN = 'filtered-out',
	OPEN   = 'filtered-open'

function normalize( text ) {

	return String( text == null ? '' : text )
		.normalize( 'NFD' )
		.replace( /[\u0300-\u036f]/g, '' )
		.toLowerCase()
		.trim()
}

function matches( name, term ) {

	let needle = normalize( term )

	if( !needle ) return true

	return normalize( name ).indexOf( needle ) !== -1
}



//note(dgmid): mark every row with the state the filter decides, and return how many
//rows matched by name — that is what tells "nothing found" apart from an empty box.

function apply( root, term ) {

	let $root = $( root ),
		found = 0

	$root.find( '.folder-tree-item' ).removeClass( HIDDEN + ' ' + OPEN )

	if( !normalize( term ).length ) return found

	function walk( $item ) {

		let self = matches( $item.children( 'a.filter.folder' ).attr( 'data-name' ), term ),
			keepBelow = false

		$item.children( '.folder-tree' ).children( '.folder-tree-item' ).each( function() {

			if( walk( $( this ) ) ) keepBelow = true
		})

		if( self ) found++

		$item.toggleClass( HIDDEN, !( self || keepBelow ) )

		//note(dgmid): open the branch that leads to a match, even if it was collapsed
		$item.toggleClass( OPEN, !self && keepBelow )

		return self || keepBelow
	}

	$root.children( '.folder-tree' ).children( '.folder-tree-item' ).each( function() {

		walk( $( this ) )
	})

	return found
}



module.exports.apply 		= apply
module.exports.matches 		= matches
module.exports.normalize 	= normalize
