(function () {
    'use strict';

    const CONFIG = {
        captureInterval: 1200,
        maxLogItems: 15,
        strokeWidth: 3,
        fontSize: 14,
        minConfidence: 0.50,
        maxConsecutiveFailures: 2, 
        smoothingFactor: 0.25,

        classesEPI: [
            'protective-glasses',
            'safety-glasses',
            'oculos',
            'oculos-seguranca',
            'safety_goggles',
            'goggles'
        ],
        classesHuman: [
            'person',
            'face',
            'head',
            'rosto'
        ]
    };

    let state = {
        stream: null,
        facingMode: 'environment', 
        isProcessing: false,
        lastInferenceTime: null,
        fpsHistory: [],
        lastFrameTimestamp: performance.now(),
        audioCtx: null,
        alarmIntervalId: null,
        isAlarmPlaying: false,
        consecutiveFailures: 0,
        smoothedBox: null,
        apiConfig: {
            apiKey: localStorage.getItem('rf_apiKey') || '',
            modelId: localStorage.getItem('rf_modelId') || '',
            version: localStorage.getItem('rf_version') || '1'
        }
    };

    const elements = {
        webcam: document.getElementById('webcam'),
        canvas: document.getElementById('analytics-canvas'),
        workspace: document.getElementById('video-workspace'),
        videoWrapper: document.getElementById('video-wrapper-element'),
        violationBanner: document.getElementById('violation-banner'),
        systemPulse: document.getElementById('system-pulse'),
        clock: document.getElementById('live-clock'),
        fps: document.getElementById('fps-counter'),
        processingOverlay: document.getElementById('processing-overlay'),
        btnSwitchCamera: document.getElementById('btn-switch-camera'),
        btnFullscreen: document.getElementById('btn-fullscreen'),
        btnConfig: document.getElementById('btn-config'),
        statusCam: document.getElementById('status-cam').querySelector('.value'),
        statusApi: document.getElementById('status-api').querySelector('.value'),
        metricSafetyStatus: document.getElementById('metric-safety-status'),
        metricCount: document.getElementById('metric-count'),
        metricTime: document.getElementById('metric-time'),
        metricLatency: document.getElementById('metric-latency'),
        logContainer: document.getElementById('log-container'),
        
        modal: document.getElementById('config-modal'),
        btnSaveConfig: document.getElementById('btn-save-config'),
        btnCloseConfig: document.getElementById('btn-close-config'),
        cfgApiKey: document.getElementById('cfg-api-key'),
        cfgModelId: document.getElementById('cfg-model-id'),
        cfgModelVer: document.getElementById('cfg-model-ver')
    };

    const ctx = elements.canvas.getContext('2d');
    let inferenceIntervalId = null;

    function init() {
        setupClock();
        setupEventListeners();
        syncCanvasResolution();
        startCamera();
        
        if (!state.apiConfig.apiKey || !state.apiConfig.modelId) {
            updateStatusElement(elements.statusApi, 'CONFIG. REQUERIDA', 'state-offline');
            setTimeout(() => openConfigModal(), 1000);
        } else {
            updateStatusElement(elements.statusApi, 'PRONTO', 'state-online');
            startInferenceLoop();
        }

        window.addEventListener('resize', () => {
            syncCanvasResolution();
        });
    }

    function initAudio() {
        if (!state.audioCtx) {
            state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
    }

    function startAlarm() {
        initAudio();
        if (state.isAlarmPlaying) return;
        state.isAlarmPlaying = true;

        state.alarmIntervalId = setInterval(() => {
            if (!state.isAlarmPlaying || !state.audioCtx) return;
            
            try {
                const osc = state.audioCtx.createOscillator();
                const gain = state.audioCtx.createGain();
                
                osc.type = 'sawtooth'; 
                osc.frequency.setValueAtTime(850, state.audioCtx.currentTime); 
                
                gain.gain.setValueAtTime(0.3, state.audioCtx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, state.audioCtx.currentTime + 0.4);
                
                osc.connect(gain);
                gain.connect(state.audioCtx.destination);
                
                osc.start();
                osc.stop(state.audioCtx.currentTime + 0.4);
            } catch (e) {
                console.error("Falha ao emitir áudio: ", e);
            }
        }, 500);
    }

    function stopAlarm() {
        if (!state.isAlarmPlaying) return;
        state.isAlarmPlaying = false;
        if (state.alarmIntervalId) {
            clearInterval(state.alarmIntervalId);
            state.alarmIntervalId = null;
        }
    }

    async function startCamera() {
        if (state.stream) {
            state.stream.getTracks().forEach(track => track.stop());
        }

        updateStatusElement(elements.statusCam, 'INICIALIZANDO...', 'state-processing');

        const constraints = {
            video: {
                facingMode: state.facingMode,
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        };

        try {
            state.stream = await navigator.mediaDevices.getUserMedia(constraints);
            elements.webcam.srcObject = state.stream;
            
            elements.webcam.onloadedmetadata = () => {
                syncCanvasResolution();
                updateStatusElement(elements.statusCam, 'ATIVO', 'state-online');
                requestAnimationFrame(calculateFPS);
            };
        } catch (error) {
            console.error('Erro de acesso à câmera: ', error);
            updateStatusElement(elements.statusCam, 'ERRO DE CAPTURA', 'state-offline');
        }
    }

    function switchCamera() {
        state.facingMode = (state.facingMode === 'user') ? 'environment' : 'user';
        startCamera();
    }

    function syncCanvasResolution() {
        const rect = elements.webcam.getBoundingClientRect();
        elements.canvas.width = elements.webcam.videoWidth || rect.width;
        elements.canvas.height = elements.webcam.videoHeight || rect.height;
    }

    function startInferenceLoop() {
        if (inferenceIntervalId) clearInterval(inferenceIntervalId);
        
        inferenceIntervalId = setInterval(async () => {
            if (state.isProcessing || !state.stream || !state.apiConfig.apiKey || !state.apiConfig.modelId) return;
            
            state.isProcessing = true;
            elements.processingOverlay.classList.add('active');
            const startTime = performance.now();

            try {
                const base64Image = captureFrameAsBase64();
                if (base64Image) {
                    const response = await sendFrameToRoboflow(base64Image);
                    const latency = Math.round(performance.now() - startTime);
                    
                    if (response && response.predictions) {
                        processPredictions(response.predictions, latency);
                        updateStatusElement(elements.statusApi, 'ONLINE', 'state-online');
                    }
                }
            } catch (error) {
                console.error('Erro na chamada da API Roboflow: ', error);
                updateStatusElement(elements.statusApi, 'ERRO CONEXÃO', 'state-offline');
            } finally {
                state.isProcessing = false;
                elements.processingOverlay.classList.remove('active');
            }
        }, CONFIG.captureInterval);
    }

    function captureFrameAsBase64() {
        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = elements.webcam.videoWidth;
        offscreenCanvas.height = elements.webcam.videoHeight;
        
        const offscreenCtx = offscreenCanvas.getContext('2d');
        if (offscreenCanvas.width === 0 || offscreenCanvas.height === 0) return null;
        
        offscreenCtx.drawImage(elements.webcam, 0, 0, offscreenCanvas.width, offscreenCanvas.height);
        return offscreenCanvas.toDataURL('image/jpeg', 0.65).split(',')[1];
    }

    async function sendFrameToRoboflow(base64Str) {
        const url = `https://detect.roboflow.com/${state.apiConfig.modelId}/${state.apiConfig.version}?api_key=${state.apiConfig.apiKey}`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: base64Str
        });

        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        return await response.json();
    }

    function processPredictions(predictions, latency) {
        ctx.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
        elements.metricLatency.textContent = `${latency}ms`;

        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0];
        elements.metricTime.textContent = timeStr;

      
        const validPredictions = predictions.filter(pred => pred.confidence >= CONFIG.minConfidence);

        
        if (validPredictions.length === 0) {
            state.consecutiveFailures = 0;
            state.smoothedBox = null;
            stopAlarm(); 

            elements.videoWrapper.classList.remove('danger-frame');
            elements.violationBanner.classList.remove('active');
            elements.systemPulse.classList.remove('danger');

            elements.metricSafetyStatus.textContent = "SEM PESSOA";
            elements.metricSafetyStatus.className = "metric-val state-processing"; 
            elements.metricCount.textContent = 0;
            return; 
        }

        clearLogPlaceholder();

       
        const glassesPredictions = validPredictions.filter(pred => 
            CONFIG.classesEPI.includes(pred.class.toLowerCase())
        );

        const humanPredictions = validPredictions.filter(pred => 
            CONFIG.classesHuman.includes(pred.class.toLowerCase())
        );

        let glassesDetected = glassesPredictions.length > 0;
        elements.metricCount.textContent = glassesPredictions.length;

        // Âncora para desenho da caixa inteligente (dá preferência ao óculos, senão usa a face/pessoa)
        const referencePred = glassesDetected ? glassesPredictions[0] : humanPredictions[0];
        
        
        if (referencePred) {
            const targetWidth = referencePred.width * 1.20;
            const targetHeight = referencePred.height * 2.20;
            const targetX = referencePred.x - targetWidth / 2;
            const targetY = referencePred.y - targetHeight / 2;

            if (!state.smoothedBox) {
                state.smoothedBox = { x: targetX, y: targetY, width: targetWidth, height: targetHeight };
            } else {
                state.smoothedBox.x += (targetX - state.smoothedBox.x) * CONFIG.smoothingFactor;
                state.smoothedBox.y += (targetY - state.smoothedBox.y) * CONFIG.smoothingFactor;
                state.smoothedBox.width += (targetWidth - state.smoothedBox.width) * CONFIG.smoothingFactor;
                state.smoothedBox.height += (targetHeight - state.smoothedBox.height) * CONFIG.smoothingFactor;
            }
        }

  
        if (glassesDetected) {
            state.consecutiveFailures = 0;
            stopAlarm();

            elements.videoWrapper.classList.remove('danger-frame');
            elements.violationBanner.classList.remove('active');
            elements.systemPulse.classList.remove('danger');

            elements.metricSafetyStatus.textContent = "ÓCULOS OK";
            elements.metricSafetyStatus.className = "metric-val state-online";

            if (state.smoothedBox) {
                drawBoundingBox({
                    x: state.smoothedBox.x + state.smoothedBox.width / 2,
                    y: state.smoothedBox.y + state.smoothedBox.height / 2,
                    width: state.smoothedBox.width,
                    height: state.smoothedBox.height,
                    class: 'ÓCULOS'
                }, false);
            }

            pushToLog('ÓCULOS', referencePred.confidence, timeStr, false);
        } 
  
        else {
            state.consecutiveFailures++;

            if (state.consecutiveFailures <= CONFIG.maxConsecutiveFailures) {
                // Margem de tolerância para manter frames oscilantes sem falso positivo
                elements.metricSafetyStatus.textContent = "ÓCULOS OK";
                elements.metricSafetyStatus.className = "metric-val state-online";
                
                if (state.smoothedBox) {
                    drawBoundingBox({
                        x: state.smoothedBox.x + state.smoothedBox.width / 2,
                        y: state.smoothedBox.y + state.smoothedBox.height / 2,
                        width: state.smoothedBox.width,
                        height: state.smoothedBox.height,
                        class: 'ÓCULOS'
                    }, false);
                }
            } else {
               
                startAlarm();

                elements.videoWrapper.add ? elements.videoWrapper.classList.add('danger-frame') : null;
                elements.violationBanner.classList.add('active');
                elements.systemPulse.classList.add('danger');

                elements.metricSafetyStatus.textContent = "SEM ÓCULOS";
                elements.metricSafetyStatus.className = "metric-val state-offline";

                pushToLog("SEM ÓCULOS", 1, timeStr, true);

                if (state.smoothedBox) {
                    drawBoundingBox({
                        x: state.smoothedBox.x + state.smoothedBox.width / 2,
                        y: state.smoothedBox.y + state.smoothedBox.height / 2,
                        width: state.smoothedBox.width,
                        height: state.smoothedBox.height,
                        class: 'SEM ÓCULOS'
                    }, true);
                }

                
                ctx.strokeStyle = "#ff3333";
                ctx.lineWidth = 6;
                ctx.strokeRect(5, 5, elements.canvas.width - 10, elements.canvas.height - 10);

                ctx.font = "bold 32px Arial";
                ctx.fillStyle = "#ff3333";
                ctx.fillText("SEM ÓCULOS", 30, 50);
            }
        }
    }

    function drawBoundingBox(prediction, isDanger) {
        const width = prediction.width;
        const height = prediction.height;
        const x = prediction.x - width / 2;
        const y = prediction.y - height / 2;

        const colorHex = isDanger ? '#ff3333' : '#00ff66';
        
        ctx.strokeStyle = colorHex;
        ctx.lineWidth = CONFIG.strokeWidth;
        ctx.strokeRect(x, y, width, height);

        const labelText = isDanger ? `VIOLAÇÃO: SEM ÓCULOS` : `ÓCULOS OK`;
        
        ctx.font = `bold ${CONFIG.fontSize}px ${getComputedStyle(document.body).fontFamily}`;
        const textWidth = ctx.measureText(labelText).width;
        
        ctx.fillStyle = colorHex;
        ctx.fillRect(x - (CONFIG.strokeWidth / 2), y - (CONFIG.fontSize + 6), textWidth + 12, CONFIG.fontSize + 6);

        ctx.fillStyle = '#000000';
        ctx.fillText(labelText, x + 6, y - 5);
        
        if (isDanger) {
            ctx.fillStyle = 'rgba(255, 51, 51, 0.15)';
            ctx.fillRect(x, y, width, height);
            
            ctx.strokeStyle = '#ff3333';
            ctx.beginPath();
            ctx.moveTo(prediction.x - 10, prediction.y);
            ctx.lineTo(prediction.x + 10, prediction.y);
            ctx.moveTo(prediction.x, prediction.y - 10);
            ctx.lineTo(prediction.x, prediction.y + 10);
            ctx.stroke();
        }
    }

    function pushToLog(className, confidence, timeStr, isDanger) {
        const logContainer = elements.logContainer;
        const item = document.createElement('div');
        
        item.className = isDanger ? 'log-item danger-log' : 'log-item';
        
        const statusText = isDanger ? 'VIOLAÇÃO' : 'OK';
        const colorText = isDanger ? 'var(--color-offline)' : 'var(--color-text-muted)';
        const cleanClassName = isDanger ? 'SEM ÓCULOS' : 'ÓCULOS';

        item.innerHTML = `
            <span style="color: ${colorText}">${cleanClassName} [${statusText}]</span>
            <span style="color: var(--color-text-muted)">${Math.round(confidence * 100)}% (${timeStr})</span>
        `;

        logContainer.insertBefore(item, logContainer.firstChild);

        if (logContainer.children.length > CONFIG.maxLogItems) {
            logContainer.removeChild(logContainer.lastChild);
        }
    }

    function clearLogPlaceholder() {
        const placeholder = elements.logContainer.querySelector('.log-placeholder');
        if (placeholder) placeholder.remove();
    }

    function updateStatusElement(el, text, className) {
        el.textContent = text;
        el.className = 'value'; 
        el.classList.add(className);
    }

    function setupClock() {
        setInterval(() => {
            const now = new Date();
            elements.clock.textContent = now.toTimeString().split(' ')[0];
        }, 1000);
    }

    function calculateFPS() {
        const now = performance.now();
        const fps = Math.round(1000 / (now - state.lastFrameTimestamp));
        state.lastFrameTimestamp = now;

        state.fpsHistory.push(fps);
        if (state.fpsHistory.length > 20) state.fpsHistory.shift();

        const avgFps = Math.round(state.fpsHistory.reduce((a, b) => a + b, 0) / state.fpsHistory.length);
        elements.fps.textContent = `FPS: ${avgFps.toString().padStart(2, '0')}`;

        if (state.stream) requestAnimationFrame(calculateFPS);
    }

    function toggleFullscreen() {
        if (!document.fullscreenElement) {
            elements.workspace.requestFullscreen()
                .then(() => syncCanvasResolution())
                .catch(err => console.error(err));
        } else {
            document.exitFullscreen().then(() => syncCanvasResolution());
        }
    }

    function openConfigModal() {
        initAudio(); 
        elements.cfgApiKey.value = state.apiConfig.apiKey;
        elements.cfgModelId.value = state.apiConfig.modelId;
        elements.cfgModelVer.value = state.apiConfig.version;
        elements.modal.classList.add('active');
    }

    function closeConfigModal() {
        elements.modal.classList.remove('active');
    }

    function saveConfig() {
        const key = elements.cfgApiKey.value.trim();
        const model = elements.cfgModelId.value.trim();
        const ver = elements.cfgModelVer.value.trim();

        if (!key || !model || !ver) {
            alert('Configurações incompletas.');
            return;
        }

        localStorage.setItem('rf_apiKey', key);
        localStorage.setItem('rf_modelId', model);
        localStorage.setItem('rf_version', ver);

        state.apiConfig.apiKey = key;
        state.apiConfig.modelId = model;
        state.apiConfig.version = ver;

        closeConfigModal();
        updateStatusElement(elements.statusApi, 'REINICIANDO', 'state-processing');
        startInferenceLoop();
    }

    function setupEventListeners() {
        elements.btnSwitchCamera.addEventListener('click', (e) => {
            e.stopPropagation();
            switchCamera();
        });
        
        elements.btnFullscreen.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFullscreen();
        });

        elements.workspace.addEventListener('click', (e) => {
            initAudio(); 
            if (e.target === elements.webcam || e.target === elements.workspace) {
                toggleFullscreen();
            }
        });

        elements.btnConfig.addEventListener('click', (e) => {
            e.stopPropagation();
            openConfigModal();
        });
        
        elements.btnSaveConfig.addEventListener('click', saveConfig);
        elements.btnCloseConfig.addEventListener('click', closeConfigModal);
    }

    document.addEventListener('DOMContentLoaded', init);

})();