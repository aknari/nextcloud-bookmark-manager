'use strict'

const fs = require( 'fs-extra' )
const Store = require( 'electron-store' )
let store
try {
	store = new Store()
} catch( e ) {
	store = { get: () => null, set: () => {} }
}

//note(dgmid): local cache of server-generated preview screenshots (fetched from the
//Nextcloud Bookmarks API endpoint /bookmark/{id}/image), keyed by bookmark id.
//The URL map lets us drop a stale image when a bookmark's URL changes.

function previewDir() {
	return store.get( 'dirPath' )
}

//note(dgmid): cached preview file path for a bookmark, or null. Validates that the
//cached image still belongs to the bookmark's current URL (the server regenerates
//the screenshot when the URL changes, so a stale local copy is dropped).

module.exports.getPreviewPath = function( id, url ) {
	
	let dir = previewDir()
	if( !dir ) return null
	
	let map = store.get( '_previewUrlMap' ) || {}
	
	for( let ext of [ 'png', 'jpg', 'jpeg' ] ) {
		
		let file = `${dir}/previews/${id}.${ext}`
		
		if( fs.pathExistsSync( file ) ) {
			
			if( map[id] === url ) return file
			
			//note(dgmid): the bookmark URL changed — the cached image is stale
			try { fs.removeSync( file ) } catch( e ) {}
			return null
		}
	}
	
	return null
}

//note(dgmid): download the server-generated screenshot for a bookmark and cache it
//locally. Resolves with the local file path, or null on any failure.

module.exports.fetchPreview = async function( id, url ) {
	
	let dir 	= previewDir(),
		server 	= store.get( 'loginCredentials.server' ),
		user 	= store.get( 'loginCredentials.username' ),
		pass 	= store.get( 'loginCredentials.password' )
	
	if( !dir || !server || !user || !pass || !url ) return null
	
	try {
		
		let res = await fetch(
			server + '/index.php/apps/bookmarks/public/rest/v2/bookmark/' + id + '/image',
			{
				headers: { 'Authorization': 'Basic ' + btoa( user + ':' + pass ) },
				cache: 'no-cache'
			}
		)
		
		if( !res.ok ) return null
		
		let buf = Buffer.from( await res.arrayBuffer() )
		
		//note(dgmid): guard against empty/tiny bodies (some servers answer 200 with nothing)
		if( buf.length < 100 ) return null
		
		let ctype 	= ( res.headers.get( 'content-type' ) || '' ).toLowerCase(),
			ext 	= ( ctype.includes( 'jpeg' ) || ctype.includes( 'jpg' ) ) ? 'jpg' : 'png',
			file 	= `${dir}/previews/${id}.${ext}`
		
		fs.outputFileSync( file, buf )
		
		let map = store.get( '_previewUrlMap' ) || {}
		map[ id ] = url
		store.set( '_previewUrlMap', map )
		
		return file
		
	} catch( e ) {
		return null
	}
}

//note(dgmid): cached favicon file URL for a bookmark (2x first, then 1x), or ''
//when none exists — used as the fallback tile inside a card.

module.exports.getFaviconUrl = function( id ) {
	
	let dir = previewDir()
	if( !dir ) return ''
	
	for( let f of [ `${dir}/favicons/${id}@2x.png`, `${dir}/favicons/${id}.png` ] ) {
		
		if( fs.pathExistsSync( f ) ) return 'file://' + encodeURI( f )
	}
	
	return ''
}
