document.addEventListener('DOMContentLoaded', () => {
    console.log('[Init] Starting BART Voice Assistant');
    
    const voiceOrb = document.querySelector('.voice-orb');
    const feedbackElement = document.getElementById('feedback');
    let recognition = null;
    let isListening = false;
    let audioQueue = [];
    let isPlaying = false;
    let currentEventSource = null;
    let speechContext = null;
    let audioContext = null;
    let mediaStream = null;
    let lastQueryTime = 0;
    let currentAudioSource = null;
    let decodedChunks = new Map();
    let nextPlayTime = 0;
    let pendingChunks = [];
    let currentChunkIndex = 0;
    let audioBufferCache = new Map(); // Add this to store decoded audio buffers

    // Initialize audio context
    async function initAudioContext() {
        try {
            console.log('[Audio] Initializing audio context');
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // Create speech detection using Hark
            const options = {
                threshold: -50,  // voice activity detection threshold
                interval: 50     // check more frequently for lower latency
            };
            
            speechContext = hark(mediaStream, options);
            
            // Handle speech start
            speechContext.on('speaking', () => {
                console.log('[Speech] Speech detected');
                if (!isListening && recognition) {
                    startNewRecognition();
                }
            });
            
            // Handle speech end
            speechContext.on('stopped_speaking', () => {
                console.log('[Speech] Speech ended');
            });
            
            console.log('[Audio] Audio context initialized successfully');
            return true;
        } catch (error) {
            console.error('[Error] Audio initialization failed:', error);
            showFeedback('Please allow microphone access to use the voice assistant.');
            return false;
        }
    }

    // Initialize speech recognition
    function initSpeechRecognition() {
        if (!('webkitSpeechRecognition' in window)) {
            console.error('[Error] Speech recognition not supported');
            showFeedback('Speech recognition is not supported in this browser. Please use Chrome.');
            return null;
        }

        console.log('[Speech] Initializing speech recognition');
        const recognition = new webkitSpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onstart = () => {
            console.log('[Speech] Recognition started');
            isListening = true;
            if (voiceOrb) voiceOrb.classList.add('listening');
            showFeedback('Ask me about BART schedules and information');
        };

        recognition.onend = () => {
            console.log('[Speech] Recognition ended');
            isListening = false;
            if (voiceOrb) voiceOrb.classList.remove('listening');
        };

        recognition.onresult = (event) => {
            // Get only the most recent transcript, not accumulated from previous queries
            const lastResultIndex = event.results.length - 1;
            const transcript = event.results[lastResultIndex][0].transcript;

            if (event.results[lastResultIndex].isFinal) {
                console.log('[Speech] Final transcript:', transcript);
                
                // Implement debouncing to prevent rapid-fire queries
                const now = Date.now();
                if (now - lastQueryTime > 1000) { // Minimum 1 second between queries
                    lastQueryTime = now;
                    showFeedback('Getting BART information...');
                    handleQuery(transcript);
                    
                    // Stop current recognition session after processing query
                    // to ensure next query starts fresh
                    recognition.stop();
                } else {
                    console.log('[Speech] Query debounced');
                }
            }
        };

        recognition.onerror = (event) => {
            console.error('[Error] Speech recognition error:', event.error);
            isListening = false;
            if (voiceOrb) voiceOrb.classList.remove('listening');
            
            switch (event.error) {
                case 'no-speech':
                    break;
                case 'audio-capture':
                    showFeedback('No rophone found. Please ensure it is connected and allowed.');
                    break;
                case 'not-allowed':
                    showFeedback('Please allow microphone access to use the voice assistant.');
                    break;
                case 'network':
                    showFeedback('Network error occurred. Please check your connection.');
                    break;
                default:
                    showFeedback('An error occurred. Please try again.');
            }
        };

        return recognition;
    }

    function showFeedback(message) {
        console.log('[Feedback]', message);
        if (feedbackElement) {
            feedbackElement.textContent = message;
            feedbackElement.classList.add('visible');
            
            if (message !== 'Ask me about BART schedules and information') {
                setTimeout(() => {
                    feedbackElement.classList.remove('visible');
                }, 3000);
            }
        }
    }

    async function handleQuery(text) {
        console.log('[Query] Processing new query:', text);
        
        // Clear previous feedback
        showFeedback('');
        
        // Reset audio queue and state
        stopCurrentPlayback();
        
        // Send the new query to the server
        await sendToServer(text);
    }

    function stopCurrentPlayback() {
        console.log('[Audio] Stopping current playback');
        if (currentEventSource) {
            currentEventSource.close();
            currentEventSource = null;
        }

        if (currentAudioSource) {
            try {
                currentAudioSource.stop();
                currentAudioSource.disconnect();
            } catch (error) {
                console.log('[Audio] Error stopping current source:', error);
            }
            currentAudioSource = null;
        }

        audioQueue = [];
        pendingChunks = [];
        decodedChunks.clear();
        audioBufferCache.clear();
        isPlaying = false;
        nextPlayTime = 0;
        currentChunkIndex = 0;

        if (voiceOrb) {
            voiceOrb.classList.remove('processing');
        }
    }

    function startNewRecognition() {
        console.log('[Speech] Starting new recognition session');
        if (recognition) {
            recognition.abort();
        }
        recognition = initSpeechRecognition();
        if (recognition) {
            // Reset any existing speech state
            if (currentEventSource) {
                currentEventSource.close();
                currentEventSource = null;
            }
            recognition.start();
        }
    }

    async function sendToServer(text) {
        // Reset state for new query
        pendingChunks = [];
        currentChunkIndex = 0;
        isPlaying = false;
        audioBufferCache.clear(); // Clear audio buffer cache for new query

        try {
            console.log('[Server] Sending request to server');
            const requestStartTime = Date.now();

            if (currentEventSource) {
                currentEventSource.close();
            }

            if (voiceOrb) voiceOrb.classList.add('processing');
            
            audioQueue = [];

            const params = new URLSearchParams();
            params.append('input', text);

            currentEventSource = new EventSource(`/process?${params.toString()}`);

            currentEventSource.onmessage = (event) => {
                const data = JSON.parse(event.data);
                console.log('[Server] Received chunk:', data);
                
                if (data.is_final) {
                    console.log('[Server] Request completed in:', Date.now() - requestStartTime, 'ms');
                    currentEventSource.close();
                    currentEventSource = null;
                    if (!isPlaying && voiceOrb) {
                        voiceOrb.classList.remove('processing');
                    }
                    showFeedback('Ask another question about BART');
                    return;
                }

                if (data.text) {
                    showFeedback(data.text);
                }

                if (data.audio) {
                    // Add chunk to pending chunks array with its index
                    pendingChunks.push({
                        audio: data.audio,
                        text: data.text,
                        index: data.chunk_index
                    });
                    
                    // Sort chunks by index to ensure correct order
                    pendingChunks.sort((a, b) => a.index - b.index);
                    
                    // Start pre-decoding immediately when we get new chunks
                    if (pendingChunks.length <= 3) {
                        preDecodeAudio(pendingChunks);
                    }
                    
                    // If not playing, start playback
                    if (!isPlaying) {
                        processNextChunk();
                    }
                }
            };

            currentEventSource.onerror = (error) => {
                console.error('[Error] EventSource error:', error);
                currentEventSource.close();
                currentEventSource = null;
                if (voiceOrb) voiceOrb.classList.remove('processing');
                showFeedback('Error getting BART information. Please try asking again.');
            };

        } catch (error) {
            console.error('[Error] Request failed:', error);
            showFeedback('Error getting BART information. Please try asking again.');
            if (voiceOrb) voiceOrb.classList.remove('processing');
        }
    }

    // New function to pre-decode audio
    async function preDecodeAudio(chunks) {
        const startTime = Date.now();
        const decodingPromises = [];
        
        // Identify chunks that need decoding
        for (const chunk of chunks) {
            if (!audioBufferCache.has(chunk.index) && chunk.audio) {
                decodingPromises.push(decodeAudio(chunk.audio, chunk.index));
            }
        }
        
        if (decodingPromises.length > 0) {
            console.log(`[Audio] Pre-decoding ${decodingPromises.length} chunks`);
            await Promise.all(decodingPromises);
            console.log(`[Audio] Pre-decoded ${decodingPromises.length} chunks in ${Date.now() - startTime}ms`);
        }
    }
    
    // Function to decode a single audio chunk
    async function decodeAudio(audioBase64, index) {
        try {
            // Convert base64 to ArrayBuffer
            const binaryString = atob(audioBase64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            
            // Decode audio and store in cache
            const audioBuffer = await audioContext.decodeAudioData(bytes.buffer);
            audioBufferCache.set(index, audioBuffer);
            return audioBuffer;
        } catch (error) {
            console.error(`[Error] Failed to decode audio chunk ${index}:`, error);
            return null;
        }
    }

    // New function to process chunks in order
    async function processNextChunk() {
        if (pendingChunks.length === 0) {
            console.log('[Audio] No pending chunks');
            isPlaying = false;
            if (voiceOrb) voiceOrb.classList.remove('processing');
            return;
        }
        
        // Always pre-decode next few chunks
        await preDecodeAudio(pendingChunks.slice(0, 3));
        
        // Find the next chunk in sequence
        const nextChunkIndex = pendingChunks.findIndex(chunk => chunk.index === currentChunkIndex);
        
        if (nextChunkIndex === -1) {
            // If next chunk in sequence is not available yet, wait
            console.log(`[Audio] Waiting for chunk index ${currentChunkIndex}`);
            isPlaying = true;
            return;
        }
        
        // Get the next chunk and remove it from pending list
        const chunk = pendingChunks.splice(nextChunkIndex, 1)[0];
        console.log(`[Audio] Processing chunk ${chunk.index}: "${chunk.text}"`);
        
        // Increment current chunk index for next time
        currentChunkIndex++;
        
        // Get or decode the audio buffer
        let audioBuffer;
        if (audioBufferCache.has(chunk.index)) {
            audioBuffer = audioBufferCache.get(chunk.index);
            console.log(`[Audio] Using cached buffer for chunk ${chunk.index}`);
        } else {
            console.log(`[Audio] Decoding chunk ${chunk.index} on-demand`);
            audioBuffer = await decodeAudio(chunk.audio, chunk.index);
        }
        
        if (!audioBuffer) {
            console.error(`[Error] No audio buffer for chunk ${chunk.index}`);
            processNextChunk(); // Skip this chunk
            return;
        }
        
        // Schedule next chunk decoding immediately
        if (pendingChunks.length > 0) {
            setTimeout(() => {
                preDecodeAudio(pendingChunks.slice(0, 3));
            }, 0);
        }
        
        // Play this chunk
        await playAudioBuffer(audioBuffer, chunk.index);
        
        // Process next chunk
        processNextChunk();
    }

    // Function to play a decoded audio buffer
    async function playAudioBuffer(audioBuffer, chunkIndex) {
        try {
            const playStartTime = Date.now();
            isPlaying = true;
            
            // Create and configure audio source
            const source = audioContext.createBufferSource();
            source.buffer = audioBuffer;
            
            // Connect directly to output
            source.connect(audioContext.destination);
            
            // Store current source
            currentAudioSource = source;
            
            // Create a promise that resolves when playback completes
            return new Promise((resolve) => {
                source.onended = () => {
                    console.log(`[Audio] Chunk ${chunkIndex} finished in: ${Date.now() - playStartTime}ms`);
                    currentAudioSource = null;
                    
                    // Clean up this buffer from cache to save memory
                    audioBufferCache.delete(chunkIndex);
                    
                    resolve();
                };
                
                // Start playing immediately
                source.start(0);
                console.log(`[Audio] Started playing chunk ${chunkIndex}, duration: ${audioBuffer.duration}s`);
            });
            
        } catch (error) {
            console.error(`[Error] Audio playback failed for chunk ${chunkIndex}:`, error);
            currentAudioSource = null;
            return Promise.resolve(); // Continue to next chunk even on error
        }
    }

    // Initialize audio buffer for faster first-time playback
    function initAudioBuffer() {
        if (audioContext) {
            const sampleBuffer = audioContext.createBuffer(1, 1024, audioContext.sampleRate);
            const source = audioContext.createBufferSource();
            source.buffer = sampleBuffer;
            source.connect(audioContext.destination);
            source.start(0);
            console.log('[Audio] Audio buffer initialized');
        }
    }

    async function initialize() {
        console.log('[Init] Initializing application');
        const audioInitialized = await initAudioContext();
        if (audioInitialized) {
            initAudioBuffer(); // Initialize audio buffer
            recognition = initSpeechRecognition();
            if (recognition) {
                startNewRecognition();
            }
        }
    }

    initialize();

    window.addEventListener('beforeunload', () => {
        console.log('[Cleanup] Cleaning up resources');
        if (speechContext) {
            speechContext.stop();
        }
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
        }
        if (recognition) {
            recognition.stop();
        }
        if (currentEventSource) {
            currentEventSource.close();
        }
        if (audioContext) {
            audioContext.close();
        }
    }); 
}); 