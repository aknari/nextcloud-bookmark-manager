'use strict'

const {
	app,
	BrowserWindow,
	Notification

} = require( 'electron' )

const path 			= require( 'path' )
const fs 			= require( 'fs-extra' )
const nativeImage 	= require( 'electron' ).nativeImage
const axios 		= require( 'axios' ).default
const Store			= require( 'electron-store' )
const store 		= new Store()
const log  			= require( 'electron-log' )

const dir 			= store.get( 'dirPath' )


// One-time cleanup: the old favicon cache was filled with broken purple images from
// api.faviconkit.com. Delete them so fresh ones are fetched from Google's working API.
// This flag ensures we only do this once.
if( !store.get( '_faviconCacheCleaned' ) ) {
	
	log.info( `favicon: one-time cleanup of old (broken) favicon cache...` )
	
	fs.remove( `${dir}/favicons/`, err => {
		
		if ( err ) {
			
			log.error( `favicon: cleanup error: ${err.message}` )
			
		} else {
			
			log.info( `favicon: old cache cleared successfully` )
			store.set( '_faviconCacheCleaned', true )
		}
	})
}



module.exports.regenerate = function ( winId ) {
	
	const i18n = require( './i18n.min' )
	
	log.info( `clearing favicon cache for on-demand regeneration` )
	
	store.set( 'defaultIcons', [] )
	store.set( '_faviconCacheCleaned', false )
	
	notify( app.name, i18n.t('favicons:clearing', 'Clearing favicon cache') )
	
	fs.remove( `${dir}/favicons/`, err => {
		
		if ( err ) return console.error( err )
		
		log.info( `deleted cached favicons` )
		store.set( '_faviconCacheCleaned', false )
		
		// Favicons will be regenerated on-demand when bookmarks are viewed
		notify( app.name, i18n.t('favicons:cleared', 'Favicon cache cleared') )
	})
}



function notify( title, body ) {
	
	const note ={
		title: title,
		body: body
	}
	
	new Notification( note ).show()
}



/**
 * Download and cache a single favicon for the given bookmark.
 * Returns the path to the cached favicon file, or null on failure.
 */
module.exports.getFaviconPath = async function( id, url ) {
	
	// Check cache first
	if( fs.pathExistsSync( `${dir}/favicons/${id}.png` ) ) {
		
		log.info( `favicon: ${id} - cache HIT` )
		return `${dir}/favicons/${id}.png`
	}
	
	log.info( `favicon: ${id} - cache MISS, will download` )
	
	// Parse URL to get domain
	let bookmarkUrl
	try {
		
		bookmarkUrl = new URL( url )
		
	} catch ( e ) {
		
		log.info( `favicon: ${id} - invalid URL, skipping: ${url}` )
		return null
	}
	
	let file 	= `${dir}/favicons/${id}.png`,
		file2x	= `${dir}/favicons/${id}@2x.png`
	
	// Google favicons API expects the full URL (protocol + hostname + path)
	// e.g. https://www.google.com/s2/favicons?sz=32&domain_url=https://www.elpais.com/
	const fullUrl = bookmarkUrl.href
	
	// Primary source: Google favicons API (most reliable)
	// Fallback: api.faviconkit.com
	try {
		
		const response = await axios.get(
			
			`https://www.google.com/s2/favicons?sz=32&domain_url=${encodeURIComponent(fullUrl)}`,
			{ responseType: 'arraybuffer', timeout: 8000 }
		)
		
		const contentType = response.headers['content-type'] || ''
		
		if( contentType.includes('png') || contentType.includes('jpeg') || contentType.includes('x-icon') ) {
			
			const buffer = Buffer.from(response.data, "utf-8")
			
			let imgpng = nativeImage.createFromBuffer(buffer, {
					
					scaleFactor: 1.0
				}).resize({
					width: 16,
					height: 16,
					quality: 'best'
				}).toPNG()
			
			let imgpng2x = nativeImage.createFromBuffer(buffer, {
					
					scaleFactor: 1.0
				}).resize({
					width: 32,
					height: 32,
					quality: 'best'
				}).toPNG()
			
			fs.outputFileSync(file, imgpng)
			fs.outputFileSync(file2x, imgpng2x)
			
			log.info( `favicon: ${id} - generated from Google for ${fullUrl}` )
			return file
		}
		
		// Content type not an image – try fallback
		throw new Error( `unexpected content-type: ${contentType}` )
		
	} catch( err ) {
		
		log.info( `favicon: ${id} - Google fallback, trying api.faviconkit.com: ${err.message}` )
		
		try {
			
			const response2 = await axios.get(
				
				`https://api.faviconkit.com/${bookmarkUrl.hostname}/32`,
				{ responseType: 'arraybuffer', timeout: 8000 }
			)
			
			const buffer = Buffer.from(response2.data, "utf-8")
			
			let imgpng = nativeImage.createFromBuffer(buffer, {
					
					scaleFactor: 1.0
				}).resize({
					width: 16,
					height: 16,
					quality: 'best'
				}).toPNG()
			
			let imgpng2x = nativeImage.createFromBuffer(buffer, {
					
					scaleFactor: 1.0
				}).resize({
					width: 32,
					height: 32,
					quality: 'best'
				}).toPNG()
			
			fs.outputFileSync(file, imgpng)
			fs.outputFileSync(file2x, imgpng2x)
			
			log.info( `favicon: ${id} - generated from faviconkit for ${bookmarkUrl.hostname}` )
			return file
			
		} catch( err2 ) {
			
			log.info( `favicon: ${id} - both sources failed: ${err2.message}` )
			return null
		}
	}
}



module.exports.generate = function ( winId, singleBookmark ) {
	
	// Single bookmark generation – used by update-favicon after adding a new bookmark
	if( singleBookmark ) {
		
		let win = BrowserWindow.fromId( winId )
		
		module.exports.getFaviconPath( singleBookmark.id, singleBookmark.url ).then(() => {
			
			win.webContents.send( 'load-tray-menu' )
		})
	}
}



module.exports.get = function ( id ) {
	
	if( fs.pathExistsSync( `${dir}/favicons/${id}.png` ) ) {
		
		return `${dir}/favicons/${id}.png`
		
	} else {
		
		return path.join(__dirname, '../assets/png/faviconTemplate.png') 
	}
}



module.exports.exists = function ( id ) {
	
	return ( fs.pathExistsSync( `${dir}/favicons/${id}.png` ) ) ? true : false
}
