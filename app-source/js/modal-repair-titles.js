'use strict'

const i18n = require( './i18n.min' )

// Polyfill: make electron-store work in renderer
try {
	const electron = require( 'electron' )
	const remote = require( '@electron/remote' )
	if( !electron.app ) electron.app = remote.app
} catch( e ) {}

const { ipcRenderer } = require( 'electron' )

const Store = require( 'electron-store' )
let store
try {
	store = new Store()
} catch( e ) {
	store = { get: () => null, set: () => {} }
}

const $ = require( 'jquery' )
const jqueryI18next = require( 'jquery-i18next' )
const log = require( 'electron-log' )
const httpReq = require( './http-request.min' )
const fetchApi = require( './fetch.min' )

jqueryI18next.init(i18n, $)

//note(dgmid): set lang & localize strings

$('html').attr('lang', i18n.language)
$('header').localize()
$('.section-title').localize()
$('.hint').localize()
$('label').localize()
$('button').localize()



//note(dgmid): log exceptions

window.onerror = function( error, url, line ) {
	
	ipcRenderer.send( 'error-in-render', {error, url, line} )
}



// ============================================================
// Mojibake detection / repair
// Titles were double-encoded at some point: UTF-8 bytes read as
// Latin-1/Windows-1252 and re-saved. "LÃ¡mpara" → re-decode → "Lámpara",
// and the Windows-1252 variants (… – — ‘ ’ “ ” • ™ …) come out as
// "â€¦" / "â€“" / "â€™" / "â€œ" — three-byte sequences the old
// 0xC2-0xDF pair check never saw.
// ============================================================

// Windows-1252: code point → byte for the 0x80–0x9F range. Browsers decode UTF-8
// bytes with cp1252, so continuation bytes 0x80–0x9F become € „ … † ‡ “ ” etc.
// instead of Latin-1 control characters — reversing that requires this map.

const _CP1252 = {
	0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
	0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
	0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
	0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
	0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
	0x017E: 0x9E, 0x0178: 0x9F
}

//note(dgmid): chars → bytes as cp1252 would; null when the string contains a
//character that can't be a Latin-1/1252 byte (emoji, CJK, proper Vietnamese…)
//— such strings aren't the latin-1 mojibake family.

//note(dgmid): can this code point stand for a Latin-1/1252 byte in mojibake text?

function _canMapChar( cp ) {
	
	return cp <= 0xFF || _CP1252[ cp ] != null
}

//note(dgmid): chars → bytes as cp1252 would; null when the string contains a
//character that can't be a Latin-1/1252 byte (emoji, CJK, proper Vietnamese…)
//— such strings aren't the latin-1 mojibake family.

function _toMojibakeBytes( s ) {
	
	let out = []
	
	for( let ch of s ) {
		
		let cp = ch.codePointAt( 0 )
		
		if( !_canMapChar( cp ) ) return null
		
		out.push( cp <= 0xFF ? cp : _CP1252[ cp ] )
	}
	
	return Buffer.from( out )
}

//note(dgmid): a decoded string must be genuinely clean to be accepted — no
//replacement chars, no C1 controls, no zero-width/bidi-format junk.

function _isCleanText( s ) {
	
	for( let ch of s ) {
		
		let cp = ch.codePointAt( 0 )
		
		if( cp === 0xFFFD ) return false
		if( cp >= 0x80 && cp <= 0x9F ) return false
		if( ( cp >= 0x200B && cp <= 0x200F ) || ( cp >= 0x202A && cp <= 0x202E ) ) return false
	}
	
	return true
}

//note(dgmid): classic two-byte mojibake pair (Ã©, Å¡, Ã± …) — kept as its own
//check because some mixed/double-encoded titles also carry characters outside
//the cp1252 range (emojis), which the round-trip below deliberately skips.

function _hasMojibakePair( s ) {
	
	let chars = [ ...s ]
	
	for( let i = 0; i < chars.length - 1; i++ ) {
		
		let c1 = chars[i].codePointAt( 0 ),
			c2 = chars[i + 1].codePointAt( 0 )
		
		// UTF-8 lead byte (0xC2-0xDF) followed by a continuation byte (0x80-0xBF)
		if( c1 >= 0xC2 && c1 <= 0xDF && c2 >= 0x80 && c2 <= 0xBF ) return true
	}
	
	return false
}

//note(dgmid): round trip — the characters, read back as cp1252 bytes, decode to
//different, valid, clean UTF-8. Genuine Unicode text always round-trips to
//itself (or isn't cp1252-encodable), so this never false-positives on good titles.

function _roundTripsDifferently( s ) {
	
	let buf = _toMojibakeBytes( s )
	
	if( !buf ) return false
	
	let dec = buf.toString( 'utf8' )
	
	if( dec.includes( '\uFFFD' ) ) return false
	
	return dec !== s && _isCleanText( dec )
}

function detectMojibake( s ) {
	
	if( !s || typeof s !== 'string' ) return false
	
	return _hasMojibakePair( s ) || _roundTripsDifferently( s )
}

function repairMojibake( s ) {
	
	if( typeof s !== 'string' ) return null
	
	// 1) cp1252 round trip, repeated for double-encoded strings (max 4 passes)
	let cur = s
	
	for( let i = 0; i < 4; i++ ) {
		
		let buf = _toMojibakeBytes( cur )
		
		if( !buf ) break
		
		let dec = buf.toString( 'utf8' )
		
		// U+FFFD = invalid byte sequence — the damage is beyond a simple re-decode
		if( dec.includes( '\uFFFD' ) || dec === cur || !_isCleanText( dec ) ) break
		
		cur = dec
		
		if( !detectMojibake( cur ) ) return cur
	}
	
	// 2) legacy latin-1 single pass — safety net for odd cases
	try {
		
		let dec = Buffer.from( s, 'latin1' ).toString( 'utf8' )
		
		if( dec !== s && !dec.includes( '\uFFFD' ) && _isCleanText( dec ) && !detectMojibake( dec ) ) return dec
		
	} catch( e ) {}
	
	return null
}



//note(dgmid): byte-stream decode that never aborts on a stray invalid byte: bytes
//that can't start/continue a UTF-8 sequence are kept as the character they stand
//for (their cp1252 code point), and the rest of the run still decodes. Used only
//by the best-effort pass — clean text always survives unchanged because its bytes
//never decode to anything different.

function _decodeRunTolerant( runStr ) {
	
	let bytes = _toMojibakeBytes( runStr ) || []
	
	let out = [],
		i = 0
	
	while( i < bytes.length ) {
		
		let b = bytes[i]
		
		if( b < 0x80 ) {
			
			out.push( String.fromCharCode( b ) )
			i++
			continue
		}
		
		// expected continuation count for this lead byte (invalid leads → keep char)
		let n = ( b >= 0xC2 && b <= 0xDF ) ? 1
			: ( b >= 0xE0 && b <= 0xEF ) ? 2
			: ( b >= 0xF0 && b <= 0xF4 ) ? 3
			: 0
		
		if( n === 0 || i + n >= bytes.length ) {
			
			out.push( _byteChar( b ) )
			i++
			continue
		}
		
		let ok = true
		
		for( let k = 1; k <= n; k++ ) {
			
			let cb = bytes[ i + k ]
			
			if( cb < 0x80 || cb > 0xBF ) { ok = false; break }
		}
		
		if( !ok ) {
			
			out.push( _byteChar( b ) )
			i++
			continue
		}
		
		let cp
		
		if( n === 1 ) {
			
			cp = ( ( b & 0x1F ) << 6 ) | ( bytes[ i + 1 ] & 0x3F )
			
		} else if( n === 2 ) {
			
			// reject overlongs (E0 80-9F) and lone surrogates (ED A0-BF)
			if( b === 0xE0 && bytes[ i + 1 ] < 0xA0 ) { out.push( _byteChar( b ) ); i++; continue }
			if( b === 0xED && bytes[ i + 1 ] >= 0xA0 ) { out.push( _byteChar( b ) ); i++; continue }
			
			cp = ( ( b & 0x0F ) << 12 ) | ( ( bytes[ i + 1 ] & 0x3F ) << 6 ) | ( bytes[ i + 2 ] & 0x3F )
			
		} else {
			
			// reject overlongs (F0 80-8F) and > U+10FFFF (F4 90-BF)
			if( b === 0xF0 && bytes[ i + 1 ] < 0x90 ) { out.push( _byteChar( b ) ); i++; continue }
			if( b === 0xF4 && bytes[ i + 1 ] >= 0x90 ) { out.push( _byteChar( b ) ); i++; continue }
			
			cp = ( ( b & 0x07 ) << 18 ) | ( ( bytes[ i + 1 ] & 0x3F ) << 12 ) | ( ( bytes[ i + 2 ] & 0x3F ) << 6 ) | ( bytes[ i + 3 ] & 0x3F )
		}
		
		out.push( String.fromCodePoint( cp ) )
		i += n + 1
	}
	
	return out.join( '' )
}


//note(dgmid): the character a cp1252 byte stands for — the inverse of the special
//0x80-0x9F map, so a real € stays € instead of becoming U+0080

function _byteChar( b ) {
	
	if( b >= 0x80 && b <= 0x9F ) {
		
		for( let cp in _CP1252 ) {
			
			if( _CP1252[ cp ] === b ) return String.fromCodePoint( parseInt( cp, 10 ) )
		}
	}
	
	return String.fromCharCode( b )
}


//note(dgmid): last-resort OFFLINE cleanup for strings the strict decoder refuses
//(mixed or double-encoded text carrying emojis / non-Latin-1 characters). Decodes
//each maximal run of "byte-like" characters separately and leaves real characters
//(emoji, CJK, …) untouched — a run is only replaced when its bytes decode to
//clean, valid, different UTF-8, so the result is the correct decode of whatever
//parts are recoverable, never a wholesale guess. The output may be PARTIAL — the
//caller must present it as approximate, not as an exact recovery.

function bestEffortRepairMojibake( s ) {
	
	if( typeof s !== 'string' || !s ) return null
	
	let cur = s,
		changedAny = false
	
	// a run may still look like mojibake after one decode — repeat while it improves
	for( let pass = 0; pass < 4; pass++ ) {
		
		let out 	= [],
			changed = false,
			i 		= 0
		
		while( i < cur.length ) {
			
			let cp = cur.codePointAt( i )
			
			if( !_canMapChar( cp ) ) {
				
				// real character (emoji, CJK, astral…) — never touch it
				let ch = String.fromCodePoint( cp )
				out.push( ch )
				i += ch.length
				continue
			}
			
			// maximal run of consecutive byte-like characters
			let run = []
			
			while( i < cur.length && _canMapChar( cur.codePointAt( i ) ) ) {
				
				run.push( cur.codePointAt( i ) )
				i += String.fromCodePoint( cur.codePointAt( i ) ).length
			}
			
			let runStr 	= String.fromCodePoint( ...run ),
				decoded = _decodeRunTolerant( runStr )
			
			if( decoded !== runStr && !decoded.includes( '\uFFFD' ) && _isCleanText( decoded ) ) {
				
				out.push( decoded )
				changed = true
				
			} else {
				
				out.push( runStr )
			}
		}
		
		changedAny = changedAny || changed
		
		if( !changed ) break
		
		cur = out.join( '' )
		
		if( !detectMojibake( cur ) ) break
	}
	
	return ( changedAny && cur !== s ) ? cur : null
}




// ============================================================
// Web title/description fetching (Node http/https, shared module)
// ============================================================

function fetchPageMeta( url ) {
	
	if( !url || !/^https?:\/\//i.test( url ) ) return Promise.resolve( null )
	
	return httpReq.fetchPageMeta( url, 12000 )
		.then( meta => {
			
			if( !meta ) return null
			
			// safety net: a site serving an odd charset can still come back mangled
			if( meta.title && detectMojibake( meta.title ) ) {
				
				let fixed = repairMojibake( meta.title )
				
				if( fixed ) meta.title = fixed
			}
			
			if( meta.description && detectMojibake( meta.description ) ) {
				
				let fixed = repairMojibake( meta.description )
				
				if( fixed ) meta.description = fixed
			}
			
			return meta
		})
}



// ============================================================
// State
// ============================================================

let selection 		= ( store.get( '_repairTitlesSelection' ) || [] ).filter( b => b && b.id != null )
let allBookmarks 	= ( store.get( '_repairTitlesAll' ) || [] ).filter( b => b && b.id != null )

let results 		= [],
	running 		= false,
	applying 		= false,
	fillEmptyDesc 	= false		// fill empty descriptions from the page (optional, off by default)

// default scope: the selected bookmarks when there is a selection, otherwise all
let scopeSelected = selection.length > 0



// ============================================================
// UI wiring
// ============================================================

$('#cfg-selected').text( selection.length )
$('#cfg-total').text( allBookmarks.length )

function renderScope() {
	
	$('#scope-selected').prop( 'checked', scopeSelected )
	$('#scope-all').prop( 'checked', !scopeSelected )
	
	// no selection → "selected" scope is meaningless, force "all"
	if( selection.length === 0 ) {
		
		scopeSelected = false
		$('#scope-selected').prop( 'checked', false )
		$('#scope-all').prop( 'checked', true )
		$('#scope-selected').prop( 'disabled', true )
		$('#scope-selected-label').css( 'opacity', 0.45 )
		
	} else {
		
		$('#scope-selected').prop( 'disabled', false )
		$('#scope-selected-label').css( 'opacity', 1 )
	}
}

renderScope()

$('#scope-selected').on( 'change', function() {
	if( $(this).is( ':checked' ) ) scopeSelected = true
})

$('#scope-all').on( 'change', function() {
	if( $(this).is( ':checked' ) ) scopeSelected = false
})

$('#chk-fill-desc').on( 'change', function() {
	
	fillEmptyDesc = $(this).is( ':checked' )
})



function setProgress( current, total, text ) {
	
	let pct = total > 0 ? Math.round( ( current / total ) * 100 ) : 0
	
	$('#progress-fill').css( 'width', pct + '%' )
	$('#progress-text').text( text )
}



function esc( s ) {
	
	return String( s == null ? '' : s )
		.replace( /&/g, '&amp;' )
		.replace( /</g, '&lt;' )
		.replace( />/g, '&gt;' )
		.replace( /"/g, '&quot;' )
}



//note(dgmid): one-line status under the footer buttons — tells the user what the
//last completed step was (scan / apply), so the buttons don't look perpetually idle

function setActionStatus( text ) {
	
	$('#action-status').text( text || '' )
}



//note(dgmid): start — scan the scope, repair locally, then fetch from the web

$('#btn-start').click( function() {
	
	if( running ) return
	
	//note(dgmid): a fresh scan invalidates the previous scan/apply status markers
	$('#btn-start, #btn-apply').removeClass( 'done' )
	setActionStatus( '' )
	
	running = true
	
	$('#btn-start').prop( 'disabled', true )
	$('#step-start').hide()
	$('#step-results').hide()
	$('#step-progress').show()
	
	let scope = scopeSelected ? selection : allBookmarks
	
	//note(dgmid): candidates = corrupt/empty titles + corrupt descriptions (+ empty
	//descriptions when the "fill empty" option is on)
	let candidates = scope.filter( b => {
		
		let titleBad 	= !b.title || detectMojibake( b.title )
		let desc 		= b.description || ''
		let descBad 	= detectMojibake( desc ) || ( fillEmptyDesc && !desc )
		
		return titleBad || descBad
	})
	
	if( candidates.length === 0 ) {
		
		running = false
		
		ipcRenderer.send( 'show-error-box', {
			title: i18n.t( 'repairtitles:done.title', 'Repair Titles' ),
			content: i18n.t( 'repairtitles:summary.none', 'No corrupted titles or descriptions found in the selected scope.' )
		})
		
		$('#btn-start').prop( 'disabled', false )
		$('#step-progress').hide()
		$('#step-start').show()
		
		//note(dgmid): the scan did run — mark it done and say so
		$('#btn-start').addClass( 'done' )
		setActionStatus( i18n.t( 'repairtitles:status.none', 'Scan complete — nothing corrupted found in the selected scope.' ) )
		return
	}
	
	// Phase 1 — local mojibake repair (instant, offline)
	//note(dgmid): a locally-fixed item STILL goes to the web pass when there is a
	//pending description fill (fillEmptyDesc + empty description) — otherwise the
	//"fill empty descriptions" option would silently no-op for every bookmark whose
	//corrupted title happens to be fixable locally.
	results = candidates.map( b => {
		
		let oldTitle 	= b.title || '',
			oldDesc 	= b.description || '',
			newTitle 	= oldTitle,
			newDesc 	= oldDesc
		
		let titleFixedLocal = false,
			descFixedLocal 	= false
		
		if( oldTitle && detectMojibake( oldTitle ) ) {
			
			let f = repairMojibake( oldTitle )
			
			if( f && f !== oldTitle ) { newTitle = f; titleFixedLocal = true }
		}
		
		if( oldDesc && detectMojibake( oldDesc ) ) {
			
			let f = repairMojibake( oldDesc )
			
			if( f && f !== oldDesc ) { newDesc = f; descFixedLocal = true }
		}
		
		let r = {
			id: b.id,
			url: b.url,
			oldTitle: oldTitle,
			newTitle: newTitle,
			oldDesc: oldDesc,
			newDesc: newDesc,
			titleFixedLocal: titleFixedLocal,
			descFixedLocal: descFixedLocal,
			// whether this item had REAL corruption (vs. merely an empty description
			// waiting to be filled) — decides 'unrecoverable' vs. 'skipped' at the end
			hadCorruption: ( oldTitle && detectMojibake( oldTitle ) ) || ( oldDesc && detectMojibake( oldDesc ) ),
			source: 'local',
			status: 'pending',
			accepted: false
		}
		
		// still needs the web pass when the title is empty/still corrupt or a
		// description fill is pending (or a corrupt description couldn't be fixed)
		let titleNeedsWeb = !oldTitle || ( oldTitle && detectMojibake( oldTitle ) && !titleFixedLocal )
		let descNeedsWeb  = ( fillEmptyDesc && !oldDesc ) || ( oldDesc && detectMojibake( oldDesc ) && !descFixedLocal )
		
		if( titleNeedsWeb || descNeedsWeb ) {
			
			r.source = 'web'
			
		} else {
			
			// fully resolved offline
			r.status 	= 'ok'
			r.accepted 	= true
		}
		
		return r
	})
	
	// Phase 2 — web title/description fetch for everything still pending
	let pending = results.filter( r => r.status === 'pending' )
	
	webFetchAll( pending, function() {
		
		running = false
		
		$('#step-progress').hide()
		
		renderResults()
		
		$('#step-results').show()
		$('#btn-apply').show()
		$('#btn-start').prop( 'disabled', false )
		
		//note(dgmid): the scan just finished — keep the button enabled but mark the
		//step as done so it's obvious it has already run
		$('#btn-start').addClass( 'done' )
		setActionStatus( i18n.t( 'repairtitles:status.scanned', 'Scan complete — {{total}} checked, {{recovered}} recovered. You can scan again.', {
			total: results.length,
			recovered: results.filter( r => r.status === 'ok' ).length
		}) )
	})
})



//note(dgmid): process the web queue N-at-a-time (a flood of requests to random sites
//gets refused or times out; a small concurrency keeps the run responsive)

function webFetchAll( list, done ) {
	
	if( list.length === 0 ) { done(); return }
	
	const CONCURRENCY = 5
	
	let nextIndex = 0,
		finished  = 0
	
	function onDone() {
		
		finished++
		
		setProgress( finished, list.length,
			i18n.t( 'repairtitles:progress.fetch', 'Fetching titles from the web… {{current}} of {{total}}', {
				current: Math.min( finished + 1, list.length ),
				total: list.length
			})
		)
		
		if( finished === list.length ) {
			done()
			return
		}
		
		processNext()
	}
	
	function processNext() {
		
		if( nextIndex >= list.length ) return
		
		let r = list[ nextIndex++ ]
		
		fetchPageMeta( r.url ).then( meta => {
			
			let changed = false
			
			if( meta ) {
				
				// title: propose only when the stored one is empty or still corrupted
				// AND was not already fixed locally (don't overwrite a good local fix)
				let titleStillBad = !r.oldTitle || ( r.oldTitle && detectMojibake( r.oldTitle ) )
				
				if( !r.titleFixedLocal && titleStillBad && meta.title && meta.title !== r.oldTitle ) {
					
					r.newTitle 	= meta.title
					changed 	= true
				}
				
				// description: fill only when empty AND the option is on
				if( fillEmptyDesc && !r.oldDesc && meta.description ) {
					
					r.newDesc 	= meta.description
					changed 	= true
				}
			}
			
			let hadLocalFix = r.titleFixedLocal || r.descFixedLocal
			
			if( changed ) {
				
				r.status 	= 'ok'
				r.accepted 	= true
				r.source 	= hadLocalFix ? 'both' : 'web'
				
			} else if( ( r.newTitle && detectMojibake( r.newTitle ) ) || ( r.newDesc && detectMojibake( r.newDesc ) ) ) {
				
				//note(dgmid): the page didn't provide the real text — offer a best-effort
				//offline decode of the recoverable parts as an APPROXIMATE proposal
				//(never auto-applied; the user accepts each row explicitly)
				let titleFixed 	= false,
					descFixed 	= false
				
				if( r.newTitle && detectMojibake( r.newTitle ) ) {
					
					let t = bestEffortRepairMojibake( r.newTitle )
					
					if( t ) { r.newTitle = t; titleFixed = true }
				}
				
				if( r.newDesc && detectMojibake( r.newDesc ) ) {
					
					let d = bestEffortRepairMojibake( r.newDesc )
					
					if( d ) { r.newDesc = d; descFixed = true }
				}
				
				if( titleFixed || descFixed ) {
					
					r.status 	= 'approx'
					r.source 	= 'approx'
					r.accepted 	= false
					
				} else if( hadLocalFix ) {
					
					// the offline fix stands on its own — keep it applicable; the still
					// corrupt field simply stays for a future scan
					r.status 	= 'ok'
					r.accepted 	= true
					r.source 	= 'local'
					
				} else {
					
					// genuine damage even the byte-run decode refused — truly unrecoverable
					r.status 	= 'unrecoverable'
					r.accepted 	= false
				}
				
			} else if( hadLocalFix ) {
				
				// the offline fix stands on its own — nothing more to apply
				r.status 	= 'ok'
				r.accepted 	= true
				r.source 	= 'local'
				
			} else {
				
				// merely an empty description the page didn't provide one for
				r.status 	= 'skipped'
				r.accepted 	= false
			}
			onDone()
		})
	}
	
	const workers = Math.min( CONCURRENCY, list.length )
	
	for( let w = 0; w < workers; w++ ) processNext()
}



function renderResults() {
	
	let ok 			= results.filter( r => r.status === 'ok' ),
		localCount 	= ok.filter( r => r.source === 'local' ).length,
		webCount 	= ok.filter( r => r.source === 'web' ).length,
		bothCount 	= ok.filter( r => r.source === 'both' ).length,
		unrec 		= results.filter( r => r.status === 'unrecoverable' ).length,
		skipped 	= results.filter( r => r.status === 'skipped' ).length,
		approx 	= results.filter( r => r.status === 'approx' ).length
	
	let summary = i18n.t( 'repairtitles:summary.recovered', '{{recovered}} of {{total}} bookmarks recovered ({{local}} local, {{web}} web, {{both}} both).', {
		recovered: ok.length,
		total: results.length,
		local: localCount,
		web: webCount,
		both: bothCount
	})
	
	if( approx > 0 ) {
		summary += ' ' + i18n.t( 'repairtitles:summary.approx', '{{count}} repaired approximately (best-effort decode — review them before applying).', { count: approx } )
	}
	
	if( unrec > 0 ) {
		summary += ' ' + i18n.t( 'repairtitles:summary.unrecoverable', '{{count}} could not be recovered.', { count: unrec } )
	}
	
	if( skipped > 0 ) {
		summary += ' ' + i18n.t( 'repairtitles:summary.skipped', '{{count}} could not be completed (the page did not provide the missing information).', { count: skipped } )
	}
	
	$('#summary-stats').html( '<strong>' + esc( summary ) + '</strong>' )
	
	let html = ''
	
	for( let r of results ) {
		
		// "skipped" items are merely empty descriptions the page didn't provide
		// one for — nothing to apply, no need for a row
		if( r.status === 'skipped' ) continue
		
		let titleChanged = r.newTitle !== r.oldTitle,
			descChanged  = r.newDesc !== r.oldDesc
		
		if( r.status === 'ok' || r.status === 'approx' ) {
			
			html += '<div class="result-item">'
				+ '<label class="toggle-line">'
				+ '<input type="checkbox" class="item-toggle" data-id="' + r.id + '"' + ( r.accepted ? ' checked' : '' ) + '>'
				+ '<span class="badge badge-' + r.source + '">' + esc( i18n.t( 'repairtitles:badge.' + r.source, r.source ) ) + '</span>'
				+ '<div class="titles">'
			
			if( titleChanged ) {
				
				html += '<div class="field-label">' + esc( i18n.t( 'repairtitles:field.title', 'Title' ) ) + '</div>'
					+ '<div class="old-title" title="' + esc( r.oldTitle ) + '">' + esc( r.oldTitle ) + '</div>'
					+ '<div class="arrow">→</div>'
					+ '<div class="new-title" title="' + esc( r.newTitle ) + '">' + esc( r.newTitle ) + '</div>'
			}
			
			if( descChanged ) {
				
				html += '<div class="field-label">' + esc( i18n.t( 'repairtitles:field.description', 'Description' ) ) + '</div>'
					+ '<div class="old-title" title="' + esc( r.oldDesc ) + '">' + esc( r.oldDesc || '—' ) + '</div>'
					+ '<div class="arrow">→</div>'
					+ '<div class="new-title" title="' + esc( r.newDesc ) + '">' + esc( r.newDesc ) + '</div>'
			}
			
			html += '</div></label></div>'
			
		} else {
			
			let label = r.oldTitle || r.url || r.id
			
			html += '<div class="result-item unrecoverable">'
				+ '<label class="toggle-line">'
				+ '<span class="badge badge-x">✕</span>'
				+ '<div class="titles">'
				+ '<div class="old-title" title="' + esc( label ) + '">' + esc( label ) + '</div>'
				+ '<div class="arrow">—</div>'
				+ '<div class="new-title muted">' + esc( i18n.t( 'repairtitles:unrecoverable', 'could not recover' ) ) + '</div>'
				+ '</div></label></div>'
		}
	}
	
	$('#results-list').html( html )
	
	$('.item-toggle').on( 'change', function() {
		
		let id = $(this).data( 'id' ),
			r  = results.find( x => x.id === id )
		
		if( r ) r.accepted = $(this).is( ':checked' )
	})
}



//note(dgmid): apply accepted changes

$('#btn-apply').click( function() {
	
	if( applying ) return
	
	let toApply = results.filter( r => ( r.status === 'ok' || r.status === 'approx' ) && r.accepted )
	
	if( toApply.length === 0 ) {
		
		ipcRenderer.send( 'show-error-box', {
			title: i18n.t( 'repairtitles:error.noapply_title', 'No Titles to Apply' ),
			content: i18n.t( 'repairtitles:error.noapply_content', 'No recovered titles are accepted. Toggle items or run the scan again.' )
		})
		return
	}
	
	applying = true
	
	$('#btn-apply').prop( 'disabled', true ).text( i18n.t( 'repairtitles:button.applying', 'Applying…' ) )
	$('#step-results').hide()
	$('#step-progress').show()
	
	let applied = 0,
		failed  = 0
	
	function applyNext( idx ) {
		
		if( idx >= toApply.length ) {
			
			applying = false
			
			let msg = i18n.t( 'repairtitles:done.applied', 'Updated {{applied}} bookmarks.', { applied: applied } )
			
			if( failed > 0 ) {
				msg += ' ' + i18n.t( 'repairtitles:done.failed', '{{failed}} failed.', { failed: failed } )
			}
			
			ipcRenderer.send( 'show-error-box', {
				title: i18n.t( 'repairtitles:done.title', 'Repair Titles Complete' ),
				content: msg
			})
			
			//note(dgmid): refresh the main window
			ipcRenderer.send( 'refresh', 'refresh-bookmarks' )
			
			$('#btn-apply').prop( 'disabled', false ).text( i18n.t( 'repairtitles:button.apply', 'Apply to Server' ) )
			$('#btn-close').text( i18n.t( 'repairtitles:button.close', 'Close' ) )
			
			//note(dgmid): mark the apply step as done so it's clear the changes were
			//actually written to the server (the button stays enabled)
			$('#btn-apply').addClass( 'done' )
			setActionStatus( i18n.t( 'repairtitles:status.applied', 'Changes applied to the server ({{count}} bookmarks).', { count: applied } ) )
			
			$('#step-progress').hide()
			$('#step-results').show()
			
			return
		}
		
		let r = toApply[idx]
		
		//note(dgmid): send only the fields that actually changed
		let data = '?record_id=' + r.id
		
		if( r.newTitle !== r.oldTitle ) data += '&title=' + encodeURIComponent( r.newTitle )
		if( r.newDesc !== r.oldDesc ) data += '&description=' + encodeURIComponent( r.newDesc )
		
		setProgress( idx, toApply.length,
			i18n.t( 'repairtitles:progress.apply', 'Applying {{current}} of {{total}}', {
				current: idx + 1,
				total: toApply.length
			})
		)
		
		//note(dgmid): retry transient network failures (laptop sleep, Wi-Fi drop)
		fetchApi.modifyWithRetry( r.id, data, 2, function( response ) {
			
			if( response !== null ) {
				applied++
			} else {
				failed++
				log.error( `repair-titles apply failed for bookmark ${r.id}: modify API returned null after retries` )
			}
			
			setTimeout( () => applyNext( idx + 1 ), 200 )
		})
	}
	
	applyNext( 0 )
})



//note(dgmid): close button

$('#btn-close').click( function() {
	
	ipcRenderer.send( 'close-current-window' )
})
