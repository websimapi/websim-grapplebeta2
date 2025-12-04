import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { TrackManager } from './track.js';
import { Car } from './car.js';
import { Explosion, SpaceEnvironment } from './effects.js';
import { ReplayRecorder } from './replay.js';

export class Game {
    constructor() {
        this.container = document.getElementById('game-container');
        this.scoreEl = document.getElementById('score-display');
        this.grappleScoreEl = document.getElementById('grapple-display');
        this.gameOverScreen = document.getElementById('game-over-screen');
        this.finalScoreEl = document.getElementById('final-score');

        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0x050505, 0.002);

        // Camera setup
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 12000);
        this.cameraOffset = new THREE.Vector3(0, 20, -15); // Behind and above
        this.cameraLookAt = new THREE.Vector3(0, 0, 0);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ 
            antialias: false,
            preserveDrawingBuffer: true // Important for capturing canvas stream
        }); 
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.container.appendChild(this.renderer.domElement);

        // Post Processing (Bloom)
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));

        const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
        bloomPass.threshold = 0.1;
        bloomPass.strength = 1.2; // Neon glow intensity
        bloomPass.radius = 0.5;
        this.composer.addPass(bloomPass);

        // Lights
        this.addLights();

        // Input
        this.input = { mouseDown: false };
        window.addEventListener('mousedown', () => this.input.mouseDown = true);
        window.addEventListener('mouseup', () => this.input.mouseDown = false);
        window.addEventListener('touchstart', (e) => { 
            // Only capture touches on the game canvas/container so UI buttons still work
            const target = e.target;
            if (target === this.renderer.domElement || target.closest('#game-container')) {
                e.preventDefault(); 
                this.input.mouseDown = true; 
            }
        }, {passive: false});
        window.addEventListener('touchend', (e) => { 
            const target = e.target;
            if (target === this.renderer.domElement || target.closest('#game-container')) {
                e.preventDefault(); 
                this.input.mouseDown = false; 
            }
        }, {passive: false});

        // Resize
        window.addEventListener('resize', () => this.onWindowResize());

        // Game State
        this.isRunning = false;
        this.isCrashing = false;
        this.distanceTraveled = 0;
        this.explosions = [];

        // Bindings
        document.getElementById('restart-btn').addEventListener('click', () => this.reset());

        // Audio
        this.setupAudio();

        // Multiplayer / User Info
        this.room = new WebsimSocket();
        this.room.initialize();

        // Replay System
        this.replayRecorder = new ReplayRecorder(this.renderer.domElement, this.listener);

        // Explosion / crash state
        this.explosionTriggered = false;
        this.explosionTime = 0;
        this.interceptorSpawned = false;
    }

    addLights() {
        const ambientLight = new THREE.AmbientLight(0xffffff, 2.5);
        this.scene.add(ambientLight);

        const hemiLight = new THREE.HemisphereLight(0x88aaff, 0x222244, 1.2);
        this.scene.add(hemiLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
        dirLight.position.set(20, 40, 10);
        dirLight.castShadow = false;
        this.scene.add(dirLight);
    }

    setupAudio() {
        this.listener = new THREE.AudioListener();
        this.camera.add(this.listener);

        const audioLoader = new THREE.AudioLoader();
        this.engineSound = new THREE.Audio(this.listener);
        this.grappleSound = new THREE.Audio(this.listener);
        this.skidSound = new THREE.Audio(this.listener);

        audioLoader.load('./sfx_engine.mp3', (buffer) => {
            this.engineSound.setBuffer(buffer);
            this.engineSound.setLoop(true);
            this.engineSound.setVolume(0.012);
            if (this.isRunning && !this.engineSound.isPlaying) this.engineSound.play();
        });
        audioLoader.load('./sfx_grapple_shoot.mp3', (buffer) => {
            this.grappleSound.setBuffer(buffer);
            this.grappleSound.setVolume(0.5);
        });
        audioLoader.load('./sfx_skid.mp3', (buffer) => {
            this.skidSound.setBuffer(buffer);
            this.skidSound.setVolume(0.4);
        });
    }

    start() {
        if (this.listener && this.listener.context.state === 'suspended') {
            this.listener.context.resume();
        }
        this.reset();
        this.loop();
    }

    reset() {
        // Clear scene
        while(this.scene.children.length > 0){ 
            this.scene.remove(this.scene.children[0]); 
        }

        // Reset fog density
        if (this.scene.fog) this.scene.fog.density = 0.002;

        this.explosions = [];

        // Cleanup previous replay video
        const video = document.getElementById('replay-video');
        if (video) {
            video.pause();
            video.currentTime = 0;
            if (video.src && video.src.startsWith('blob:')) {
                URL.revokeObjectURL(video.src);
            }
            video.removeAttribute('src');
            video.load();
        }

        // Stop any previous recording just in case
        if (this.replayRecorder && this.replayRecorder.isRecording) {
            this.replayRecorder.stop().then(result => {
                if (result && result.url) URL.revokeObjectURL(result.url);
            });
        }

        // Re-add lights
        this.addLights();

        if (this.spaceEnvironment) {
             this.spaceEnvironment.reset();
             this.scene.add(this.spaceEnvironment.stars);
        } else {
             this.spaceEnvironment = new SpaceEnvironment(this.scene);
        }

        this.trackManager = new TrackManager(this.scene);
        this.car = new Car(this.scene);
        
        // Reset camera smoothing
        this.cameraLookAt.copy(this.car.position);
        this.camera.position.copy(this.car.position).add(new THREE.Vector3(0, 30, 20));

        this.isRunning = true;
        this.isCrashing = false;
        this.explosionTriggered = false;
        this.explosionTime = 0;
        this.interceptorSpawned = false;
        this.gameOverScreen.classList.add('hidden');
        this.distanceTraveled = 0;
        this.clock = new THREE.Clock();
        this.zoomTarget = null;
        this.zoomTransition = null;

        // Start new recording
        if (this.replayRecorder) {
            this.replayRecorder.start();
        }

        if (this.engineSound.buffer && !this.engineSound.isPlaying) this.engineSound.play();
    }

    gameOver() {
        this.isRunning = false;
        this.isCrashing = true;
        this.explosionTriggered = false;
        this.interceptorSpawned = false;
        
        // Initial fall velocity: Preserve some forward speed, add downward force
        this.fallVelocity = this.car.direction.clone().multiplyScalar(20);
        this.fallVelocity.y = -10;

        if (this.engineSound.isPlaying) this.engineSound.stop();
    }

    updateCrash(dt) {
        if (!this.explosionTriggered) {
            // Gravity
            this.fallVelocity.y -= 80 * dt; 
            
            // Apply velocity
            this.car.position.add(this.fallVelocity.clone().multiplyScalar(dt));
            this.car.mesh.position.copy(this.car.position);
            
            // Tumble rotation
            this.car.mesh.rotation.x += 5 * dt;
            this.car.mesh.rotation.z += 3 * dt;

            // Spawn Interceptor if falling deep enough
            if (!this.interceptorSpawned && this.car.position.y < -5) {
                this.spaceEnvironment.spawnInterceptor(this.car.position, this.fallVelocity);
                this.interceptorSpawned = true;
            }

            // Check Collision with Asteroids
            const hit = this.spaceEnvironment.checkCollisions(this.car.position);
            
            // Trigger explosion on hit OR failsafe depth
            if (hit || this.car.position.y < -200) {
                this.triggerExplosion();
            }
        }

        // Camera follow logic
        const timeSinceExplosion = this.explosionTriggered ? (this.clock.getElapsedTime() - this.explosionTime) : 0;
        
        // Wait 1.0 second before zooming out
        const shouldZoomOut = this.explosionTriggered && timeSinceExplosion > 1.0;

        if (shouldZoomOut) {
            // Fade out fog for better visibility during zoom out
            if (this.scene.fog.density > 0.00001) {
                this.scene.fog.density = THREE.MathUtils.lerp(this.scene.fog.density, 0.0, dt * 2.0);
            }

            // Initialize smooth zoom transition
            if (!this.zoomTransition) {
                const bounds = this.trackManager.getTrackBounds();
                let targetPos, targetLookAt;

                if (bounds) {
                    // Calculate view direction but enforce a high angle for better map visibility
                    let viewDir = new THREE.Vector3().subVectors(this.camera.position, this.car.position).normalize();
                    // Ensure we are looking down from above (bird's eye view bias)
                    if (viewDir.y < 0.6) {
                        viewDir.y = 0.6;
                        viewDir.normalize();
                    }
                    
                    // Determine distance needed to see the whole map
                    // Increased multiplier for safety on large maps
                    const dist = Math.max(bounds.maxDim * 2.5, 1000);
                    
                    targetPos = bounds.center.clone().add(viewDir.multiplyScalar(dist));
                    targetLookAt = bounds.center;
                } else {
                    // Fallback
                    targetPos = this.car.position.clone().add(new THREE.Vector3(0, 600, 600));
                    targetLookAt = this.car.position;
                }

                this.zoomTransition = {
                    startPos: this.camera.position.clone(),
                    startLookAt: this.cameraLookAt.clone(),
                    targetPos: targetPos,
                    targetLookAt: targetLookAt,
                    startTime: this.clock.getElapsedTime(),
                    duration: 4.0 // 4 seconds for a fluid cinematic movement
                };
            }

            // Perform Interpolation
            const now = this.clock.getElapsedTime();
            const elapsed = now - this.zoomTransition.startTime;
            const progress = Math.min(elapsed / this.zoomTransition.duration, 1.0);
            
            // Smootherstep for "start slow, accelerate, decelerate"
            const t = THREE.MathUtils.smootherstep(progress, 0, 1);

            this.camera.position.lerpVectors(this.zoomTransition.startPos, this.zoomTransition.targetPos, t);
            this.cameraLookAt.lerpVectors(this.zoomTransition.startLookAt, this.zoomTransition.targetLookAt, t);
            this.camera.lookAt(this.cameraLookAt);

        } else {
            // Pre-zoom behavior (falling or waiting)
            const targetCamPos = this.car.position.clone().add(new THREE.Vector3(0, 60, 40));
            const targetLookAt = this.car.position;

            let posLerpFactor, lookLerpFactor;

            if (this.explosionTriggered) {
                // During wait: stabilize camera slowly
                posLerpFactor = dt * 0.5;
                lookLerpFactor = dt * 2.0;
            } else {
                // Falling: move fast
                posLerpFactor = dt * 3.0;
                lookLerpFactor = dt * 5.0;
            }

            this.camera.position.lerp(targetCamPos, posLerpFactor);
            this.cameraLookAt.lerp(targetLookAt, lookLerpFactor);
            this.camera.lookAt(this.cameraLookAt);
        }
    }

    triggerExplosion() {
        this.explosionTriggered = true;
        this.explosionTime = this.clock.getElapsedTime();

        // Spawn Explosion at current car position
        const explosion = new Explosion(this.scene, this.car.position.clone());
        this.explosions.push(explosion);
        
        // Hide car mesh as it exploded
        this.car.hide();

        // Play explosion sound (repurposed skidSound)
        if (this.skidSound.buffer) {
            if (this.skidSound.isPlaying) this.skidSound.stop();
            this.skidSound.setVolume(1.0);
            this.skidSound.play();
        }

        // Delay showing game over overlay so explosion is visible
        setTimeout(() => {
            this.showGameOverScreen();
            // Keep isCrashing true so camera animation (zoom out) continues behind the UI
        }, 5500);
    }

    async showGameOverScreen() {
        this.gameOverScreen.classList.remove('hidden');
        this.finalScoreEl.innerText = `Distance: ${Math.floor(this.distanceTraveled)}m`;

        // Stop recording and load replay
        if (this.replayRecorder) {
            const recording = await this.replayRecorder.stop();
            if (recording) {
                const { blob, url } = recording;
                // Check if the game over screen is still active before playing
                // (Prevents video from starting if user clicked retry during processing)
                if (!this.gameOverScreen.classList.contains('hidden')) {
                    const video = document.getElementById('replay-video');
                    video.src = url;
                    video.play().catch(e => console.log('Replay autoplay blocked:', e));

                    // Post High Score
                    this.postHighScore(blob, url);
                } else {
                    URL.revokeObjectURL(url);
                }
            }
        }
    }

    async postHighScore(blob, blobUrl) {
        try {
            // Get User Info
            let username = "Guest";
            let userid = "guest";
            
            if (this.room && this.room.clientId && this.room.peers) {
                const p = this.room.peers[this.room.clientId];
                if (p) {
                    username = p.username || "Guest";
                    userid = p.id || this.room.clientId;
                } else {
                    userid = this.room.clientId;
                }
            }

            // Upload Replay to get a public URL
            let replayUrl = null;
            if (window.websim && window.websim.upload) {
                try {
                    const file = new File([blob], `grapple_replay_${Date.now()}.webm`, { type: 'video/webm' });
                    replayUrl = await window.websim.upload(file);
                } catch(e) {
                    console.error("Replay upload failed:", e);
                }
            }

            const message = {
                userid: userid,
                username: username,
                score: this.car.grappleCount,
                replay: replayUrl || ""
            };

            if (window.parent) {
                window.parent.postMessage(message, '*');
                console.log("High Score Posted:", message);
            }

        } catch (e) {
            console.error("Error posting high score:", e);
        }
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.composer.setSize(window.innerWidth, window.innerHeight);
    }

    loop() {
        requestAnimationFrame(() => this.loop());

        const dt = Math.min(this.clock.getDelta(), 0.1); // Cap dt

        // Update Explosions
        for (let i = this.explosions.length - 1; i >= 0; i--) {
            const exp = this.explosions[i];
            exp.update(dt);
            if (!exp.alive) {
                this.explosions.splice(i, 1);
            }
        }

        if (this.isRunning) {
            // Update Logic
            this.car.update(dt, this.input, this.trackManager);

            // Check Track generation
            const distToHead = this.car.position.distanceTo(this.trackManager.currentPos);
            if (distToHead < 100) {
                this.trackManager.generateNextSegment();
            }

            // Check collision/Off-road
            if (!this.trackManager.isOnTrack(this.car.position)) {
                this.gameOver();
            }

            // Update Score
            this.distanceTraveled += this.car.speed * dt;
            this.scoreEl.innerText = `DISTANCE: ${Math.floor(this.distanceTraveled)}m`;
            this.grappleScoreEl.innerText = `GRAPPLES: ${this.car.grappleCount}`;

            // Camera Follow (Rigid X/Z to fix jitter)
            // We only smooth the Y axis to dampen vertical bumps
            const targetCamY = this.car.position.y + 30;
            
            this.camera.position.x = this.car.position.x;
            this.camera.position.z = this.car.position.z + 20; // Fixed offset
            this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, targetCamY, dt * 5);
            
            // Look directly at car to prevent drift/jitter, but smooth Y look
            this.cameraLookAt.x = this.car.position.x;
            this.cameraLookAt.z = this.car.position.z;
            this.cameraLookAt.y = THREE.MathUtils.lerp(this.cameraLookAt.y, this.car.position.y, dt * 10);
            
            this.camera.lookAt(this.cameraLookAt);

            // SFX Logic
            if(this.car.grappleState === 'FIRING' && !this.grappleSound.isPlaying && this.grappleSound.buffer) {
                this.grappleSound.play();
            }
        } else if (this.isCrashing) {
            this.updateCrash(dt);
        }

        if (this.spaceEnvironment) {
            this.spaceEnvironment.update(dt, this.camera.position);
        }

        this.composer.render();
    }
}