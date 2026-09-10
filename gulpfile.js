const 	gulp 			= require('gulp'),
		sass 			= require('gulp-sass')(require('sass')),
		rename 			= require('gulp-rename'),
		autoprefixer 	= require('gulp-autoprefixer'),
		sourcemaps 		= require('gulp-sourcemaps'),
		htmlmin 		= require('gulp-htmlmin')
		cssnano 		= require('gulp-cssnano'),
		uglify 			= require('gulp-uglify-es').default,
		pump 			= require('pump'),
		iconutil 		= require('gulp-iconutil'),
		exec 			= require('child_process').exec,
		fs				= require('fs'),
		replace			= require('gulp-string-replace')



const	sourceCss 		= 'app-source/scss/*.scss',
		destCss 		= 'dist/css',
		sourceJs 		= 'app-source/js/*.js',
		destJs 			= 'dist/js',
		sourceHtml 		= 'app-source/html/*.html',
		destHtml 		= 'dist/html',
		sourcePng 		= 'app-source/assets/png/*.png',
		destPng 		= 'dist/assets/png',
		sourceLang 		= 'app-source/i18n/**/*.json',
		destLang 		= 'dist/i18n'



gulp.task('sass', () => {

	return gulp.src(sourceCss)
		.pipe(sourcemaps.init())
		.pipe(sass({ outputStyle: 'expanded' }).on('error', sass.logError))
		.pipe(autoprefixer())
		.pipe(cssnano())
		.pipe(rename({ suffix: '.min' }))
		.pipe(gulp.dest(destCss))
		.pipe(sourcemaps.write('./maps'))
		.pipe(gulp.dest(destCss))
})



gulp.task('html', () => {
	
	return gulp.src(sourceHtml)
		.pipe(htmlmin({collapseWhitespace: true}))
		.pipe(gulp.dest(destHtml))
})



gulp.task('js', done => {
	
	pump([
			gulp.src(sourceJs),
			sourcemaps.init(),
			//uglify().on('error', function(uglify) {
			//	console.error(`ERROR: ${uglify.name}, in: ${uglify.filename}`)
			//	console.error(`line: ${uglify.line}, col: ${uglify.col}`)
			//	console.error(uglify.message)
			//	this.emit('end')
			//}),
			rename({suffix: '.min'}),
			sourcemaps.write('./maps'),
			gulp.dest(destJs)
		]
	)
	
	done()
})



gulp.task('png', () => {
	
	return gulp.src(sourcePng)
		.pipe(gulp.dest(destPng))
})



gulp.task('icns', () => {

	return gulp.src('./app-source/assets/AppIcon.appiconset/icon_*.png')
		.pipe(iconutil('icon.icns'))
		.pipe(gulp.dest('./dist/assets/icon/'))
})



gulp.task('icon', () => {	
	
	return gulp.src('./app-source/assets/AppIcon.appiconset/icon_128x128@2x.png')
		.pipe(rename('icon.png'))
		.pipe(gulp.dest('./dist/assets/icon/'))
})



//note(dgmid): pack the AppIcon PNGs into a Windows .ico (PNG-compressed entries,
//supported on Windows Vista+). No external tool needed — pure Node. Sizes commonly
//expected by Windows: 16, 32, 128, 256 (the 1-byte ICO size field encodes 256 as 0).

gulp.task('ico', done => {
	
	const fs 		= require('fs'),
		  path 		= require('path')
	
	const srcDir 	= './app-source/assets/AppIcon.appiconset',
		  outDir 	= './dist/assets/icon'
	
	const sizes = [
		['icon_16x16@1x.png', 16],
		['icon_32x32@1x.png', 32],
		['icon_128x128@1x.png', 128],
		['icon_256x256@1x.png', 256]
	]
	
	const images = sizes.map( ([file, size]) => ({
		data: fs.readFileSync( path.join( srcDir, file ) ),
		size: size
	}) )
	
	//note(dgmid): ICONDIR header
	const count 	= images.length,
		  header 	= Buffer.alloc( 6 )
	
	header.writeUInt16LE( 0, 0 )	// reserved
	header.writeUInt16LE( 1, 2 )	// type: icon
	header.writeUInt16LE( count, 4 )	// image count
	
	let offset 		= 6 + count * 16
	const entries 	= [],
		  blobs 	= []
	
	for( let img of images ) {
		
		const entry = Buffer.alloc( 16 )
		
		entry.writeUInt8( img.size >= 256 ? 0 : img.size, 0 )	// width (0 = 256)
		entry.writeUInt8( img.size >= 256 ? 0 : img.size, 1 )	// height
		entry.writeUInt8( 0, 2 )								// color count
		entry.writeUInt8( 0, 3 )								// reserved
		entry.writeUInt16LE( 1, 4 )								// planes
		entry.writeUInt16LE( 32, 6 )							// bit count
		entry.writeUInt32LE( img.data.length, 8 )				// bytes in resource
		entry.writeUInt32LE( offset, 12 )						// image data offset
		
		offset += img.data.length
		entries.push( entry )
		blobs.push( img.data )
	}
	
	fs.mkdirSync( outDir, { recursive: true } )
	fs.writeFileSync( path.join( outDir, 'icon.ico' ), Buffer.concat( [ header, ...entries, ...blobs ] ) )
	
	done()
})



gulp.task('i18n', () => {
	
	return gulp.src(sourceLang)
		.pipe(gulp.dest(destLang))
})



gulp.task('clean', done => {
	
	//note(dgmid): del@8 removed the del.sync API (ESM rewrite) — use Node's fs.rmSync
	fs.rmSync( 'dist', { recursive: true, force: true } )
	fs.mkdirSync( 'dist' )
	
	done()
})



gulp.task('nodevtools', done => {
	
	gulp.src(['./app-source/js/main.js','./app-source/js/menu-app.js'], {base: './'})
		.pipe(replace('//@exclude', '/*'))
		.pipe(replace('//@end', '*/'))
		.pipe(gulp.dest('./'))
	
	done()
})



gulp.task('devtools', done => {
	
	gulp.src(['./app-source/js/main.js','./app-source/js/menu-app.js'], {base: './'})
		.pipe(replace(new RegExp('\\/\\*', 'g'), '//@exclude'))
		.pipe(replace(new RegExp('\\*\\/', 'g'), '//@end'))
		.pipe(gulp.dest('./'))
	
	done()
})



gulp.task('nowebprefs', done => {
	
	gulp.src( sourceJs, {base: './'})
		.pipe(replace('devTools: true,', 'devTools: false,'))
		.pipe(gulp.dest('./'))
	
	done()
})



gulp.task('webprefs', done => {
	
	gulp.src( sourceJs, {base: './'})
		.pipe(replace('devTools: false,', 'devTools: true,'))
		.pipe(gulp.dest('./'))
	
	done()
})


gulp.task('build', gulp.series(	
	
	'nodevtools',
	'nowebprefs',
	'clean',
	'sass',
	'html',
	'js',
	'i18n',
	'png',
	'icns',
	'icon',
	'ico',
	'devtools',
	'webprefs'
	
), done => {
	
	done()
})



gulp.task('watch', gulp.series(gulp.parallel('html', 'js', 'sass', 'i18n'), () => {
	
	gulp.watch('app-source/html/**/*.html', gulp.series('html')),
	gulp.watch('app-source/js/**/*.js', gulp.series('js')),
	gulp.watch('app-source/scss/**/*.scss', gulp.series('sass')),
	gulp.watch('app-source/i18n/**/*.json', gulp.series('i18n'))
	
	return
}))
