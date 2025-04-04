"use strict";
var SubtitlesOctopus = function (options) {
    var supportsWebAssembly = false;
    try {
        if (typeof WebAssembly === "object"
            && typeof WebAssembly.instantiate === "function") {
            const module = new WebAssembly.Module(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));
            if (module instanceof WebAssembly.Module)
                supportsWebAssembly = (new WebAssembly.Instance(module) instanceof WebAssembly.Instance);
        }
    } catch (e) {
    }
    console.log("WebAssembly support detected: " + (supportsWebAssembly ? "yes" : "no"));

    var self = this;
    self.canvas = options.canvas; // HTML canvas element (optional if video specified)
    self.renderMode = options.renderMode || (options.lossyRender ? 'lossy' : 'wasm-blend');
    self.libassMemoryLimit = options.libassMemoryLimit || 0;
    self.libassGlyphLimit = options.libassGlyphLimit || 0;
    self.targetFps = options.targetFps || 24;
    self.prescaleFactor = options.prescaleFactor || 1.0;
    self.prescaleHeightLimit = options.prescaleHeightLimit || 1080;
    self.maxRenderHeight = options.maxRenderHeight || 0; // 0 - no limit
    self.dropAllAnimations = options.dropAllAnimations || false; // attempt to remove all animations as a last ditch effort for displaying on weak hardware; may severly mangle subtitles if enabled
    self.isOurCanvas = false; // (internal) we created canvas and manage it
    self.video = options.video; // HTML video element (optional if canvas specified)
    self.canvasParent = null; // (internal) HTML canvas parent element
    self.fonts = options.fonts || []; // Array with links to fonts used in sub (optional)
    self.availableFonts = options.availableFonts || []; // Object with all available fonts (optional). Key is font name in lower case, value is link: {"arial": "/font1.ttf"}
    self.fallbackFont = options.fallbackFont || 'default.woff2'; // URL to override fallback font, for example, with a CJK one. Default fallback font is Liberation Sans (Optional)
    self.lazyFileLoading = options.lazyFileLoading || false; // Load fonts in a lazy way. Requires Access-Control-Expose-Headers for Accept-Ranges, Content-Length, and Content-Encoding. If Content-Encoding is compressed, file will be fully fetched instead of just a HEAD request.
    self.onReadyEvent = options.onReady; // Function called when SubtitlesOctopus is ready (optional)
    if (supportsWebAssembly) {
        self.workerUrl = options.workerUrl || 'subtitles-octopus-worker.js'; // Link to WebAssembly worker
    } else {
        self.workerUrl = options.legacyWorkerUrl || 'subtitles-octopus-worker-legacy.js'; // Link to legacy worker
    }
    self.subUrl = options.subUrl; // Link to sub file (optional if subContent specified)
    self.subContent = options.subContent || null; // Sub content (optional if subUrl specified)
    self.onErrorEvent = options.onError; // Function called in case of critical error meaning sub wouldn't be shown and you should use alternative method (for instance it occurs if browser doesn't support web workers).
    self.debug = options.debug || false; // When debug enabled, some performance info printed in console.
    self.lastRenderTime = 0; // (internal) Last time we got some frame from worker
    self.pixelRatio = window.devicePixelRatio || 1; // (internal) Device pixel ratio (for high dpi devices)

    self.timeOffset = options.timeOffset || 0; // Time offset would be applied to currentTime from video (option)

    self.hasAlphaBug = false;

    // private
    var targetWidth;    // Width of render target
    var targetHeight;   // Height of render target
 
    (function() {
        if (typeof ImageData.prototype.constructor === 'function') {
            try {
                // try actually calling ImageData, as on some browsers it's reported
                // as existing but calling it errors out as "TypeError: Illegal constructor"
                new window.ImageData(new Uint8ClampedArray([0, 0, 0, 0]), 1, 1);
                return;
            } catch (e) {
                console.log("detected that ImageData is not constructable despite browser saying so");
            }
        }

        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');

        window.ImageData = function () {
            var i = 0;
            if (arguments[0] instanceof Uint8ClampedArray) {
                var data = arguments[i++];
            }
            var width = arguments[i++];
            var height = arguments[i];

            var imageData = ctx.createImageData(width, height);
            if (data) imageData.data.set(data);
            return imageData;
        }
    })();

    self.workerError = function (error) {
        console.error('Worker error: ', error);
        if (self.onErrorEvent) {
            self.onErrorEvent(error);
        }
        if (!self.debug) {
            self.dispose();
            throw new Error('Worker error: ' + error);
        }
    };

    // Not tested for repeated usage yet
    self.init = function () {
        if (!window.Worker) {
            self.workerError('worker not supported');
            return;
        }
        // Worker
        if (!self.worker) {
            self.worker = new Worker(self.workerUrl);
            self.worker.addEventListener('message', self.onWorkerMessage);
            self.worker.addEventListener('error', self.workerError);
        }
        self.workerActive = false;
        self.createCanvas();
        self.setVideo(options.video);
        self.setSubUrl(options.subUrl);

        targetWidth = self.canvas.width;
        targetHeight = self.canvas.height;

        self.worker.postMessage({
            target: 'worker-init',
            width: self.canvas.width,
            height: self.canvas.height,
            URL: document.URL,
            currentScript: self.workerUrl,
            preMain: true,
            renderMode: self.renderMode,
            subUrl: self.subUrl,
            subContent: self.subContent,
            fonts: self.fonts,
            availableFonts: self.availableFonts,
            fallbackFont: self.fallbackFont,
            lazyFileLoading: self.lazyFileLoading,
            debug: self.debug,
            targetFps: self.targetFps,
            libassMemoryLimit: self.libassMemoryLimit,
            libassGlyphLimit: self.libassGlyphLimit,
            dropAllAnimations: self.dropAllAnimations
        });
    };

    self.createCanvas = function () {
        if (!self.canvas) {
            if (self.video) {
                self.isOurCanvas = true;
                self.canvas = document.createElement('canvas');
                self.canvas.className = 'libassjs-canvas';
                self.canvas.style.display = 'none';

                self.canvasParent = document.createElement('div');
                self.canvasParent.className = 'libassjs-canvas-parent';
                self.canvasParent.appendChild(self.canvas);

                if (self.video.nextSibling) {
                    self.video.parentNode.insertBefore(self.canvasParent, self.video.nextSibling);
                }
                else {
                    self.video.parentNode.appendChild(self.canvasParent);
                }
            }
            else {
                if (!self.canvas) {
                    self.workerError('Don\'t know where to render: you should give video or canvas in options.');
                }
            }
        }
        self.ctx = self.canvas.getContext('2d');
        self.bufferCanvas = document.createElement('canvas');
        self.bufferCanvasCtx = self.bufferCanvas.getContext('2d');

        // test for alpha bug, where e.g. WebKit can render a transparent pixel
        // (with alpha == 0) as non-black which then leads to visual artifacts
        self.bufferCanvas.width = 1;
        self.bufferCanvas.height = 1;
        var testBuf = new Uint8ClampedArray([0, 255, 0, 0]);
        var testImage = new ImageData(testBuf, 1, 1);
        self.bufferCanvasCtx.clearRect(0, 0, 1, 1);
        self.ctx.clearRect(0, 0, 1, 1);
        var prePut = self.ctx.getImageData(0, 0, 1, 1).data;
        self.bufferCanvasCtx.putImageData(testImage, 0, 0);
        self.ctx.drawImage(self.bufferCanvas, 0, 0);
        var postPut = self.ctx.getImageData(0, 0, 1, 1).data;
        self.hasAlphaBug = prePut[1] != postPut[1];
        if (self.hasAlphaBug) {
            console.log("Detected a browser having issue with transparent pixels, applying workaround");
        }
    };

    function onTimeUpdate() {
        self.setCurrentTime(self.video.currentTime + self.timeOffset);
    };

    function onPlaying() {
        self.setIsPaused(false, self.video.currentTime + self.timeOffset);
    }

    function onPause() {
        self.setIsPaused(true, self.video.currentTime + self.timeOffset);
    }

    function onSeeking() {
        self.video.removeEventListener('timeupdate', onTimeUpdate, false);
    }

    function onSeeked() {
        self.video.addEventListener('timeupdate', onTimeUpdate, false);

        var currentTime = self.video.currentTime + self.timeOffset;

        self.setCurrentTime(currentTime);
    }

    function onRateChange() {
        self.setRate(self.video.playbackRate);
    }

    function onWaiting() {
        self.setIsPaused(true, self.video.currentTime + self.timeOffset);
    }

    function onLoadedMetadata(e) {
        e.target.removeEventListener(e.type, onLoadedMetadata, false);
        self.resize();
    }

    self.setVideo = function (video) {
        self.video = video;
        if (self.video) {
            self.video.addEventListener('timeupdate', onTimeUpdate, false);
            self.video.addEventListener('playing', onPlaying, false);
            self.video.addEventListener('pause', onPause, false);
            self.video.addEventListener('seeking', onSeeking, false);
            self.video.addEventListener('seeked', onSeeked, false);
            self.video.addEventListener('ratechange', onRateChange, false);
            self.video.addEventListener('waiting', onWaiting, false);

            document.addEventListener("fullscreenchange", self.resizeWithTimeout, false);
            document.addEventListener("mozfullscreenchange", self.resizeWithTimeout, false);
            document.addEventListener("webkitfullscreenchange", self.resizeWithTimeout, false);
            document.addEventListener("msfullscreenchange", self.resizeWithTimeout, false);
            window.addEventListener("resize", self.resizeWithTimeout, false);

            // Support Element Resize Observer
            if (typeof ResizeObserver !== "undefined") {
                self.ro = new ResizeObserver(self.resizeWithTimeout);
                self.ro.observe(self.video);
            }

            if (self.video.videoWidth > 0) {
                self.resize();
            }
            else {
                self.video.addEventListener('loadedmetadata', onLoadedMetadata, false);
            }
        }
    };

    self.getVideoPosition = function () {
        var videoRatio = self.video.videoWidth / self.video.videoHeight;
        var width = self.video.offsetWidth, height = self.video.offsetHeight;
        var elementRatio = width / height;
        var realWidth = width, realHeight = height;
        if (elementRatio > videoRatio) realWidth = Math.floor(height * videoRatio);
        else realHeight = Math.floor(width / videoRatio);

        var x = (width - realWidth) / 2;
        var y = (height - realHeight) / 2;

        return {
            width: realWidth,
            height: realHeight,
            x: x,
            y: y
        };
    };

    self.setSubUrl = function (subUrl) {
        self.subUrl = subUrl;
    };

    self.renderFrameData = null;
    function renderFrames() {
        var data = self.renderFramesData;
        var beforeDrawTime = performance.now();
        self.ctx.clearRect(0, 0, self.canvas.width, self.canvas.height);
        for (var i = 0; i < data.canvases.length; i++) {
            var image = data.canvases[i];
            self.bufferCanvas.width = image.w;
            self.bufferCanvas.height = image.h;
            var imageBuffer = new Uint8ClampedArray(image.buffer);
            if (self.hasAlphaBug) {
                for (var j = 3; j < imageBuffer.length; j = j + 4) {
                    imageBuffer[j] = (imageBuffer[j] >= 1) ? imageBuffer[j] : 1;
                }
            }
            var imageData = new ImageData(imageBuffer, image.w, image.h);
            self.bufferCanvasCtx.putImageData(imageData, 0, 0);
            self.ctx.drawImage(self.bufferCanvas, image.x, image.y);
        }
        if (self.debug) {
            var drawTime = Math.round(performance.now() - beforeDrawTime);
            var blendTime = data.blendTime;
            if (typeof blendTime !== 'undefined') {
                console.log('render: ' + Math.round(data.spentTime - blendTime) + ' ms, blend: ' + Math.round(blendTime) + ' ms, draw: ' + drawTime + ' ms; TOTAL=' + Math.round(data.spentTime + drawTime) + ' ms');
            } else {
                console.log(Math.round(data.spentTime) + ' ms (+ ' + drawTime + ' ms draw)');
            }
            self.renderStart = performance.now();
        }
    }

    /**
     * Lossy Render Mode
     *
     */
    function renderFastFrames() {
        var data = self.renderFramesData;
        var beforeDrawTime = performance.now();
        self.ctx.clearRect(0, 0, self.canvas.width, self.canvas.height);
        for (var i = 0; i < data.bitmaps.length; i++) {
            var image = data.bitmaps[i];
            self.ctx.drawImage(image.bitmap, image.x, image.y);
        }
        if (self.debug) {
            var drawTime = Math.round(performance.now() - beforeDrawTime);
            console.log(data.bitmaps.length + ' bitmaps, libass: ' + Math.round(data.libassTime) + 'ms, decode: ' + Math.round(data.decodeTime) + 'ms, draw: ' + drawTime + 'ms');
            self.renderStart = performance.now();
        }
    }

    self.workerActive = false;
    self.frameId = 0;
    self.onWorkerMessage = function (event) {
        //dump('\nclient got ' + JSON.stringify(event.data).substr(0, 150) + '\n');
        if (!self.workerActive) {
            self.workerActive = true;
            if (self.onReadyEvent) {
                self.onReadyEvent();
            }
        }
        var data = event.data;
        switch (data.target) {
            case 'stdout': {
                console.log(data.content);
                break;
            }
            case 'console-log': {
                console.log.apply(console, JSON.parse(data.content));
                break;
            }
            case 'console-debug': {
                console.debug.apply(console, JSON.parse(data.content));
                break;
            }
            case 'console-info': {
                console.info.apply(console, JSON.parse(data.content));
                break;
            }
            case 'console-warn': {
                console.warn.apply(console, JSON.parse(data.content));
                break;
            }
            case 'console-error': {
                console.error.apply(console, JSON.parse(data.content));
                break;
            }
            case 'stderr': {
                console.error(data.content);
                break;
            }
            case 'window': {
                window[data.method]();
                break;
            }
            case 'canvas': {
                switch (data.op) {
                    case 'getContext': {
                        self.ctx = self.canvas.getContext(data.type, data.attributes);
                        break;
                    }
                    case 'resize': {
                        self.resize(data.width, data.height);
                        break;
                    }
                    case 'renderCanvas': {
                        if (self.lastRenderTime < data.time) {
                            self.lastRenderTime = data.time;
                            self.renderFramesData = data;
                            window.requestAnimationFrame(renderFrames);
                        }
                        break;
                    }
                    case 'renderFastCanvas': {
                        if (self.lastRenderTime < data.time) {
                            self.lastRenderTime = data.time;
                            self.renderFramesData = data;
                            window.requestAnimationFrame(renderFastFrames);
                        }
                        break;
                    }
                    case 'setObjectProperty': {
                        self.canvas[data.object][data.property] = data.value;
                        break;
                    }
                    default:
                        throw 'eh?';
                }
                break;
            }
            case 'tick': {
                self.frameId = data.id;
                self.worker.postMessage({
                    target: 'tock',
                    id: self.frameId
                });
                break;
            }
            case 'custom': {
                if (self['onCustomMessage']) {
                    self['onCustomMessage'](event);
                } else {
                    throw 'Custom message received but client onCustomMessage not implemented.';
                }
                break;
            }
            case 'setimmediate': {
                self.worker.postMessage({
                    target: 'setimmediate'
                });
                break;
            }
            case 'get-events': {
                break;
            }
            case 'get-styles': {
                break;
            }
            case 'ready': {
                break;
            }
            default:
                throw 'what? ' + data.target;
        }
    };

    function _computeCanvasSize(width, height) {
        var scalefactor = self.prescaleFactor <= 0 ? 1.0 : self.prescaleFactor;

        if (height <= 0 || width <= 0) {
            width = 0;
            height = 0;
        } else {
            var sgn = scalefactor < 1 ? -1 : 1;
            var newH = height;
            if (sgn * newH * scalefactor <= sgn * self.prescaleHeightLimit)
                newH *= scalefactor;
            else if (sgn * newH < sgn * self.prescaleHeightLimit)
                newH = self.prescaleHeightLimit;

            if (self.maxRenderHeight > 0 && newH > self.maxRenderHeight)
                newH = self.maxRenderHeight;

            width *= newH / height;
            height = newH;
        }

        return {'width': width, 'height': height};
    }

    self.resize = function (width, height, top, left) {
        var videoSize = null;
        top = top || 0;
        left = left || 0;
        if ((!width || !height) && self.video) {
            videoSize = self.getVideoPosition();
            var newSize = _computeCanvasSize(videoSize.width * self.pixelRatio, videoSize.height * self.pixelRatio);
            width = newSize.width;
            height = newSize.height;
            var offset = self.canvasParent.getBoundingClientRect().top - self.video.getBoundingClientRect().top;
            top = videoSize.y - offset;
            left = videoSize.x;
        }
        if (!width || !height) {
            if (!self.video) {
                console.error('width or height is 0. You should specify width & height for resize.');
            }
            return;
        }

        if (videoSize != null) {
            self.canvasParent.style.position = 'relative';
            self.canvas.style.display = 'block';
            self.canvas.style.position = 'absolute';
            self.canvas.style.width = videoSize.width + 'px';
            self.canvas.style.height = videoSize.height + 'px';
            self.canvas.style.top = top + 'px';
            self.canvas.style.left = left + 'px';
            self.canvas.style.pointerEvents = 'none';
        }

        if (targetWidth !== width || targetHeight !== height) {
            self.canvas.width = width;
            self.canvas.height = height;

            targetWidth = width;
            targetHeight = height;

            self.worker.postMessage({
                target: 'canvas',
                width: self.canvas.width,
                height: self.canvas.height
            });
        }
    };

    self.resizeWithTimeout = function () {
        self.resize();
        setTimeout(self.resize, 100);
    };

    self.runBenchmark = function () {
        self.worker.postMessage({
            target: 'runBenchmark'
        });
    };

    self.customMessage = function (data, options) {
        options = options || {};
        self.worker.postMessage({
            target: 'custom',
            userData: data,
            preMain: options.preMain
        });
    };

    self.setCurrentTime = function (currentTime) {
        self.worker.postMessage({
            target: 'video',
            currentTime: currentTime
        });
    };

    self.setTrackByUrl = function (url) {
        self.worker.postMessage({
            target: 'set-track-by-url',
            url: url
        });
    };

    self.setTrack = function (content) {
        self.worker.postMessage({
            target: 'set-track',
            content: content
        });
    };

    self.freeTrack = function (content) {
        self.worker.postMessage({
            target: 'free-track'
        });
    };


    self.render = self.setCurrentTime;

    self.setIsPaused = function (isPaused, currentTime) {
        self.worker.postMessage({
            target: 'video',
            isPaused: isPaused,
            currentTime: currentTime
        });
    };

    self.setRate = function (rate) {
        self.worker.postMessage({
            target: 'video',
            rate: rate
        });
    };

    self.dispose = function () {
        self.worker.postMessage({
            target: 'destroy'
        });

        self.worker.terminate();
        self.worker.removeEventListener('message', self.onWorkerMessage);
        self.worker.removeEventListener('error', self.workerError);
        self.workerActive = false;
        self.worker = null;

        // Remove the canvas element to remove residual subtitles rendered on player
        if (self.video) {
            self.video.removeEventListener('timeupdate', onTimeUpdate, false);
            self.video.removeEventListener('playing', onPlaying, false);
            self.video.removeEventListener('pause', onPause, false);
            self.video.removeEventListener('seeking', onSeeking, false);
            self.video.removeEventListener('seeked', onSeeked, false);
            self.video.removeEventListener('ratechange', onRateChange, false);
            self.video.removeEventListener('waiting', onWaiting, false);
            self.video.removeEventListener('loadedmetadata', onLoadedMetadata, false);

            document.removeEventListener('fullscreenchange', self.resizeWithTimeout, false);
            document.removeEventListener('mozfullscreenchange', self.resizeWithTimeout, false);
            document.removeEventListener('webkitfullscreenchange', self.resizeWithTimeout, false);
            document.removeEventListener('msfullscreenchange', self.resizeWithTimeout, false);
            window.removeEventListener('resize', self.resizeWithTimeout, false);

            self.video.parentNode.removeChild(self.canvasParent);

            self.video = null;
        }

        if (self.ro) {
            self.ro.disconnect();
            self.ro = null;
        }

        self.onCustomMessage = null;
        self.onErrorEvent = null;
        self.onReadyEvent = null;
    };

    self.fetchFromWorker = function (workerOptions, onSuccess, onError) {
        try {
            var target = workerOptions['target']

            var timeout = setTimeout(function() {
                reject(Error('Error: Timeout while try to fetch ' + target))
            }, 5000)

            var resolve = function (event) {
                if (event.data.target == target) {
                    onSuccess(event.data)
                    self.worker.removeEventListener('message', resolve)
                    self.worker.removeEventListener('error', reject)
                    clearTimeout(timeout)
                }
            }

            var reject = function (event) {
                onError(event)
                self.worker.removeEventListener('message', resolve)
                self.worker.removeEventListener('error', reject)
                clearTimeout(timeout)
            }

            self.worker.addEventListener('message', resolve)
            self.worker.addEventListener('error', reject)

            self.worker.postMessage(workerOptions)
        } catch (error) {
            onError(error)
        }
    }

    self.createEvent = function (event) {
        self.worker.postMessage({
            target: 'create-event',
            event: event
        });
    };

    self.getEvents = function (onSuccess, onError) {
        self.fetchFromWorker({
            target: 'get-events'
        }, function(data) {
            onSuccess(data.events)
        }, onError);
    };

    self.setEvent = function (event, index) {
        self.worker.postMessage({
            target: 'set-event',
            event: event,
            index: index
        });
    };

    self.removeEvent = function (index) {
        self.worker.postMessage({
            target: 'remove-event',
            index: index
        });
    };

    self.createStyle = function (style) {
        self.worker.postMessage({
            target: 'create-style',
            style: style
        });
    };
    
    self.getStyles = function (onSuccess, onError) {
        self.fetchFromWorker({
            target: 'get-styles'
        }, function(data) {
            onSuccess(data.styles)
        }, onError);
    };

    self.setStyle = function (style, index) {
        self.worker.postMessage({
            target: 'set-style',
            style: style,
            index: index
        });
    };

    self.removeStyle = function (index) {
        self.worker.postMessage({
            target: 'remove-style',
            index: index
        });
    };

    self.init();
};

if (typeof SubtitlesOctopusOnLoad == 'function') {
    SubtitlesOctopusOnLoad();
}

if (typeof exports !== 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
        exports = module.exports = SubtitlesOctopus
    }
}
