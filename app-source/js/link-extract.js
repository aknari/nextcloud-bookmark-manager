'use strict'

//note(dgmid): "Import Links from Text" — extraction module.
//It is PURE logic on purpose: no electron, no jQuery, no DOM. The modal stays a thin
//shell around it (same split as cleanup-empty), and the rules below can be exercised
//straight from Node while developing.
//
//What it does, conservatively — the one rule that matters is NEVER to break a link:
//- finds http(s):// candidates, plus bare www.host (normalized to https://)
//- trims punctuation that clings to the END of a link (final dot, ellipsis, closing
//  brackets from markdown, asterisks from bold) without touching anything inside it
//- drops links pointing at media CDNs (X/Twitter images, Reddit image subdomains,
//  YouTube thumbnails…) — when collecting sites and tools these are never wanted
//- flags (but KEEPS, offered unchecked) the URLs whose path ends in an image
//  extension, so nothing is thrown away silently
//- deduplicates, and derives a title from the text preceding the link when the paste
//  is a "Title URL" list, falling back to the URL path otherwise

//note(dgmid): any subdomain of these hosts serves media, not pages
const IMAGE_HOST_SUFFIXES = [
	'twimg.com',				// X/Twitter media (pbs., video., abs.)
	'fbcdn.net',				// Facebook/Instagram media
	'cdninstagram.com',
	'ytimg.com',				// YouTube thumbnails
	'pinimg.com',				// Pinterest images
	'googleusercontent.com',	// Google photos/avatars CDN
	'redd.it'					// i.content / preview.redd.it
]

//note(dgmid): exact hosts only — the bare domain IS a page (imgur.com/gallery/…)
const IMAGE_HOSTS_EXACT = [ 'i.imgur.com' ]

const IMAGE_EXTENSIONS = new Set([
	'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'tif', 'tiff'
])

//note(dgmid): candidates stop at whitespace and at the characters that quote or
//bracket them; ( ) [ ] stay allowed here so the trailing-bracket trim below can
//decide with the balance, instead of cutting a link from a markdown [text](url)
const CANDIDATE = /(?:https?:\/\/|www\.)[^\s<>"'`\\]+/gi

//note(dgmid): punctuation that ends a sentence right after a link
const TRAILING = new Set([ '.', ',', ';', ':', '!', '?', '\u2026', '\u2025', '*', '"', "'", '\u201d', '\u2019', '\u00bb' ])

const CLOSERS = { ')': '(', ']': '[', '}': '{' }

function count( text, ch ) {

	let n = 0

	for( let i = 0; i < text.length; i++ ) if( text[i] === ch ) n++

	return n
}

//note(dgmid): strip punctuation that only LOOKS like part of the URL. A closing
//bracket goes away only while it is unbalanced, so /wiki/Foo_(bar) survives intact.

function trimTrailing( url ) {

	let out = url

	for( ;; ) {

		if( !out.length ) return out

		let last = out[out.length - 1]

		if( TRAILING.has( last ) ) {

			out = out.slice( 0, -1 )
			continue
		}

		let opener = CLOSERS[last]

		if( opener && count( out, last ) > count( out, opener ) ) {

			out = out.slice( 0, -1 )
			continue
		}

		return out
	}
}

function hostOf( url ) {

	try {
		return new URL( url ).hostname.toLowerCase()
	} catch( e ) {
		return ''
	}
}

//note(dgmid): media CDN? Exact hosts first, then the subdomain suffixes.

function isImageHost( url ) {

	let host = hostOf( url )

	if( !host ) return false

	if( IMAGE_HOSTS_EXACT.indexOf( host ) !== -1 ) return true

	return IMAGE_HOST_SUFFIXES.some( suffix => host === suffix || host.endsWith( '.' + suffix ) )
}

//note(dgmid): a NON-media host whose last path segment still looks like an image
//file — offered in the "possible images" group (unchecked) rather than dropped

function looksLikeImageFile( url ) {

	try {

		let segments = new URL( url ).pathname.split( '/' ).filter( s => s.length > 0 )

		if( !segments.length ) return false

		let last = segments[segments.length - 1]

		if( last.indexOf( '.' ) === -1 ) return false

		return IMAGE_EXTENSIONS.has( last.split( '.' ).pop().toLowerCase() )

	} catch( e ) {

		return false
	}
}

//note(dgmid): fallback title, used when the paste is just a bare list of URLs

function titleFromUrl( url ) {

	try {

		let parsed 	= new URL( url ),
			segments = parsed.pathname.split( '/' ).filter( s => s.length > 0 ),
			last 	= segments.length ? segments[segments.length - 1] : ''

		try {
			last = decodeURIComponent( last )
		} catch( e ) {}

		last = last.replace( /\.[a-z0-9]{1,5}$/i, '' ).replace( /[-_+]+/g, ' ' ).trim()

		if( last ) return last

		return parsed.hostname.replace( /^www\./i, '' )

	} catch( e ) {

		return url
	}
}

//note(dgmid): the text sitting before a link on the same line, when it reads like a
//title. "Alonso Quesada https://…" → "Alonso Quesada"; "1. https://…" → '' (only a
//list marker, so the URL-derived title is used instead).

const LABEL_WORDS = /^(url|urls|link|links|enlace|enlaces|title|título|titulo|author|autor|time|hora|date|fecha|reply|respuesta|source|fuente)$/i

function titleFromPrecedingText( before ) {

	let text = before
		.replace( /[\s\u00a0]+/g, ' ' )
		.replace( /^[\s>*\-•·–—]+/, '' )		// bullets / quotes
		.replace( /^\d+[.)]\s*/, '' )			// "1. " / "1) "
		.replace( /^[\s>*\-•·–—]+/, '' )
		.trim()

	if( !text ) return ''

	if( LABEL_WORDS.test( text ) ) return ''

	//note(dgmid): drop the separator a "Title: url" / "Title — url" line leaves behind
	text = text.replace( /[\s:;,|–—-]+$/, '' ).trim()

	if( !text ) return ''

	if( LABEL_WORDS.test( text ) ) return ''

	return text
}

function dedupeKey( url ) {

	try {

		let parsed = new URL( url )

		return parsed.protocol + '//' + parsed.host.toLowerCase() + parsed.pathname + parsed.search + parsed.hash

	} catch( e ) {

		return url
	}
}

module.exports.extractLinks = function( text ) {

	let links 	= [],
		images 	= [],
		ignored = [],
		seen 	= new Set(),
		found 	= 0

	if( !text || typeof text !== 'string' ) {

		return { links, images, ignored, found }
	}

	for( let line of text.split( /\r?\n/ ) ) {

		if( !line.trim() ) continue

		CANDIDATE.lastIndex = 0

		let match,
			cursor = 0

		while( ( match = CANDIDATE.exec( line ) ) !== null ) {

			let before = line.slice( cursor, match.index )

			cursor = match.index + match[0].length

			let raw = trimTrailing( match[0] )

			if( !raw ) continue

			found++

			//note(dgmid): a bare "www.host" gets a scheme; without one the API rejects it
			let url = /^www\./i.test( raw ) ? 'https://' + raw : raw

			let key = dedupeKey( url )

			if( seen.has( key ) ) continue

			seen.add( key )

			let title = titleFromPrecedingText( before ) || titleFromUrl( url )

			if( isImageHost( url ) ) {

				ignored.push({ url, host: hostOf( url ) })

			} else if( looksLikeImageFile( url ) ) {

				images.push({ url, title })

			} else {

				links.push({ url, title })
			}
		}
	}

	return { links, images, ignored, found }
}



//note(dgmid): exported for the dev harness — not used by the UI
module.exports.isImageHost 		= isImageHost
module.exports.looksLikeImageFile = looksLikeImageFile
module.exports.titleFromUrl 	= titleFromUrl
module.exports.trimTrailing 	= trimTrailing
