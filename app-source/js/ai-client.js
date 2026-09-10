'use strict'

//note(dgmid): provider-agnostic AI transport. The three AI modals (auto-organize,
//auto-tag, learn-structure) used to build Gemini-only requests inline; this module is
//the single place that knows how to talk to each provider:
//
//   gemini     — Google Generative Language API (generateContent), the original default
//   openrouter — OpenRouter's OpenAI-compatible chat completions endpoint
//   local      — any OpenAI-compatible server (vLLM serving GLM / Ollama / LM Studio…)
//
//Everything downstream (prompt builders, defensive JSON parsers, quota handling) works
//on plain reply TEXT, so the modals only need to route their calls through here.

const PROVIDERS = [ 'gemini', 'openrouter', 'local' ]

const PROVIDER_LABELS = {
	gemini: 'Google Gemini',
	openrouter: 'OpenRouter',
	local: 'OpenAI-compatible server (local or cloud)'
}

const PROVIDER_DEFAULTS = {
	gemini: {
		model: 'gemini-2.5-flash',
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta'
	},
	openrouter: {
		model: '',
		baseUrl: 'https://openrouter.ai/api/v1'
	},
	local: {
		model: '',
		baseUrl: 'http://127.0.0.1:8000/v1'
	}
}

//note(dgmid): models Google has retired. A saved config naming one is silently
//substituted with the listed replacement so a run never poisons every batch with a 400.
const RETIRED_GEMINI_MODELS = {
	'gemini-2.5-flash-lite': 'gemini-3.5-flash-lite'
}

//note(dgmid): normalize whatever is saved under 'aiConfig' into a usable per-provider
//config. Old configs (no provider field) fall back to Gemini, so nothing breaks.
function normalizeConfig( raw ) {
	
	raw = raw || {}
	
	let provider = PROVIDERS.includes( raw.provider ) ? raw.provider : 'gemini',
		defaults = PROVIDER_DEFAULTS[ provider ]
	
	let cfg = {
		provider: provider,
		apiKey: String( raw.apiKey || '' ).trim(),
		model: String( raw.model || defaults.model || '' ).trim(),
		baseUrl: String( raw.baseUrl || defaults.baseUrl || '' ).trim().replace( /\/+$/, '' )
	}
	
	//note(dgmid): for an OpenAI-compatible server the base URL is user-supplied — never
	//fabricate one when the field is empty, so the config screen can ask for it honestly
	//(the transport still falls back to the 127.0.0.1 default when a saved config has none).
	if( provider === 'local' && !String( raw.baseUrl || '' ).trim() ) {
		
		cfg.baseUrl = ''
	}	
	if( provider === 'gemini' && RETIRED_GEMINI_MODELS[ cfg.model ] ) {
		
		cfg.model = RETIRED_GEMINI_MODELS[ cfg.model ]
	}
	
	return cfg
}



//note(dgmid): is this config complete enough to run? Returns null when OK, otherwise
//{ code, message } — code is one of 'noapikey' | 'nomodel' | 'nobaseurl' and message is
//a ready-to-show English explanation (each modal wraps it in its own i18n key).

function configProblem( cfg ) {
	
	if( cfg.provider === 'gemini' ) {
		
		if( !cfg.apiKey ) {
			
			return {
				code: 'noapikey',
				message: 'No Gemini API key found. Go to Bookmarks > AI Settings to set up your API key first.'
			}
		}
		
		return null
	}
	
	if( cfg.provider === 'openrouter' ) {
		
		if( !cfg.apiKey ) {
			
			return {
				code: 'noapikey',
				message: 'No OpenRouter API key found. Go to Bookmarks > AI Settings and paste your OpenRouter key first.'
			}
		}
		
		if( !cfg.model ) {
			
			return {
				code: 'nomodel',
				message: 'No OpenRouter model selected. Go to Bookmarks > AI Settings and choose a model.'
			}
		}
		
		return null
	}
	
	// local server
	if( !cfg.baseUrl ) {
		
		return {
			code: 'nobaseurl',
			message: 'No server URL configured. Go to Bookmarks > AI Settings and enter the OpenAI-compatible server address.'
		}
	}
	
	if( !cfg.model ) {
		
		return {
			code: 'nomodel',
			message: 'No model name configured. Go to Bookmarks > AI Settings and enter the model name.'
		}
	}
	
	return null
}



//note(dgmid): join a base URL with a path suffix, tolerating a base that already
//includes '/v1' (or even the full '/chat/completions' endpoint) and trailing slashes

function joinUrl( base, suffix ) {
	
	let b = String( base || '' ).trim().replace( /\/+$/, '' )
	
	if( b.endsWith( suffix ) ) return b
	
	return b + suffix
}



//note(dgmid): build the request for the configured provider. Returns
//{ url, headers, body } so callers keep their own pacing / timeout / abort handling.
//opts.json — when true, Gemini is asked for a JSON response via responseMimeType.
//OpenAI-compatible providers get no response_format (support varies by model); their
//prompts already demand JSON and the modals' parsers are defensive.

function buildChatRequest( cfg, prompt, maxTokens, opts ) {
	
	opts = opts || {}
	
	if( cfg.provider === 'gemini' ) {
		
		let body = {
			contents: [{ parts: [{ text: prompt }] }],
			generationConfig: {
				temperature: 0.3,
				maxOutputTokens: maxTokens
			}
		}
		
		if( opts.json ) body.generationConfig.responseMimeType = 'application/json'
		
		return {
			url: `${PROVIDER_DEFAULTS.gemini.baseUrl}/models/${cfg.model}:generateContent?key=${encodeURIComponent( cfg.apiKey )}`,
			headers: { 'Content-Type': 'application/json' },
			body: body
		}
	}
	
	// openrouter / local — OpenAI-compatible chat completions
	let headers = { 'Content-Type': 'application/json' }
	
	if( cfg.apiKey ) headers.Authorization = 'Bearer ' + cfg.apiKey
	
	return {
		url: joinUrl( cfg.baseUrl || PROVIDER_DEFAULTS[ cfg.provider ].baseUrl, '/chat/completions' ),
		headers: headers,
		body: {
			model: cfg.model,
			messages: [{ role: 'user', content: prompt }],
			temperature: 0.3,
			max_tokens: maxTokens
		}
	}
}



//note(dgmid): pull the reply TEXT out of a provider response, sniffing whichever shape
//the provider used (string, Gemini candidates, OpenAI choices). Works on any of them so
//callers never need to know which provider answered.

function extractTextAny( data ) {
	
	if( typeof data === 'string' ) return data
	
	if( !data ) return ''
	
	let parts = data.candidates?.[0]?.content?.parts
	
	if( Array.isArray( parts ) ) {
		
		return parts.map( p => p.text || '' ).join( '' )
	}
	
	if( data.candidates?.[0]?.content?.parts?.[0]?.text ) {
		
		return data.candidates[0].content.parts[0].text
	}
	
	if( data.choices?.[0]?.message?.content ) {
		
		return data.choices[0].message.content
	}
	
	if( data.choices?.[0]?.text ) {
		
		return data.choices[0].text
	}
	
	return ''
}



//note(dgmid): pull an error message out of a provider error response (both Gemini and
//OpenAI-compatible APIs return { error: { message } }), falling back to the HTTP status.

function extractErrorAny( status, data ) {
	
	if( data && typeof data.error === 'string' ) return data.error
	
	if( data && data.error && data.error.message ) return data.error.message
	
	if( data && typeof data.message === 'string' ) return data.message
	
	return `HTTP ${status}`
}



//note(dgmid): fetch the live model list of the configured provider for the AI Settings
//model picker. Resolves with [{ id, free }] sorted free-first; rejects with a readable
//message when the provider can't be reached (wrong key, server down, …).
//
//free: gemini → heuristic (flash/lite = free tier eligible, same rule as before);
//openrouter → REAL pricing from the API (:free suffix or prompt price 0);
//local → every model is free.

function listModels( cfg ) {
	
	if( cfg.provider === 'gemini' ) {
		
		if( !cfg.apiKey ) return Promise.reject( new Error( 'missing API key' ) )
		
		return fetch( `${PROVIDER_DEFAULTS.gemini.baseUrl}/models?key=${encodeURIComponent( cfg.apiKey )}` )
			.then( response => {
				
				if( !response.ok ) return response.json().then( data => { throw new Error( extractErrorAny( response.status, data ) ) } )
				
				return response.json()
				
			}).then( data => {
				
				let models = data.models || []
				
				models = models.filter( m => {
					
					let supported = m.supportedGenerationMethods || []
					return supported.includes('generateContent') || supported.includes('generateMessage')
				})
				
				if( models.length === 0 ) models = data.models || []
				
				let list = models.map( m => {
					
					let id = String( m.name || '' ).replace( /^models\//, '' )
					
					return {
						id: id,
						free: id.includes('flash') || id.includes('lite')
					}
				}).filter( m => m.id )
				
				list.sort( (a, b) => ( a.free === b.free ) ? b.id.localeCompare( a.id ) : ( a.free ? -1 : 1 ) )
				
				return list
			})
	}
	
	if( cfg.provider === 'openrouter' ) {
		
		if( !cfg.apiKey ) return Promise.reject( new Error( 'missing API key' ) )
		
		let headers = { 'Content-Type': 'application/json' }
		
		if( cfg.apiKey ) headers.Authorization = 'Bearer ' + cfg.apiKey
		
		return fetch( `${PROVIDER_DEFAULTS.openrouter.baseUrl}/models`, { headers: headers } )
			.then( response => {
				
				if( !response.ok ) return response.json().then( data => { throw new Error( extractErrorAny( response.status, data ) ) } )
				
				return response.json()
				
			}).then( data => {
				
				let raw = data.data || []
				
				let list = raw.filter( m => m && m.id ).map( m => {
					
					let id = String( m.id )
					
					let price = Number( m.pricing && m.pricing.prompt )
					
					return {
						id: id,
						free: id.endsWith(':free') || ( Number.isFinite( price ) && price === 0 )
					}
				})
				
				list.sort( (a, b) => ( a.free === b.free ) ? a.id.localeCompare( b.id ) : ( a.free ? -1 : 1 ) )
				
				return list
			})
	}
	
	// local server — OpenAI-style GET {base}/models, with optional bearer auth
	let headers = { 'Content-Type': 'application/json' }
	
	if( cfg.apiKey ) headers.Authorization = 'Bearer ' + cfg.apiKey
	
	return fetch( joinUrl( cfg.baseUrl || PROVIDER_DEFAULTS.local.baseUrl, '/models' ), { headers: headers } )
		.then( response => {
			
			if( !response.ok ) return response.json().then( data => { throw new Error( extractErrorAny( response.status, data ) ) } )
			
			return response.json()
			
		}).then( data => {
			
			let arr = Array.isArray( data.data ) ? data.data
				: Array.isArray( data.models ) ? data.models
				: []
			
			let list = arr.filter( m => m && ( m.id || m.name ) ).map( m => ( {
				id: String( m.id || m.name || '' ),
				free: true
			} ) ).filter( m => m.id )
			
			if( list.length === 0 ) return Promise.reject( new Error( 'Server responded but listed no models.' ) )
			
			return list
		})
}



module.exports = {
	PROVIDERS: PROVIDERS,
	PROVIDER_LABELS: PROVIDER_LABELS,
	PROVIDER_DEFAULTS: PROVIDER_DEFAULTS,
	normalizeConfig: normalizeConfig,
	configProblem: configProblem,
	buildChatRequest: buildChatRequest,
	extractTextAny: extractTextAny,
	extractErrorAny: extractErrorAny,
	listModels: listModels
}
