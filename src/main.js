import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { io } from 'socket.io-client';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Version 1.0.2 - Forced Redeploy
// --------------------------------------------------------
// SOCKET & STATE
// --------------------------------------------------------
const urlParams = new URLSearchParams(window.location.search);
const serverIp = urlParams.get('ip') || window.location.hostname;
const host = (serverIp === 'henrycui330.github.io') ? 'localhost' : serverIp;
const socket = io(`http://${host}:3000`);

let myId = null;
let myRole = 'unassigned';
let gameState = 'lobby';
let gameMode = 'extended';
let isDead = false;
let isStunned = false;
let isBlinded = false;
let hasJoined = false;
let isEquipped = false;

const otherPlayers = {}; // socket.id -> { mesh, data, weaponMesh, animType, animTime, animDuration }
const playerRegistry = {}; // socket.id -> pData
let localWeaponMesh = null; // Mesh representing the local weapon attached to camera

// --- WEAPON ANIMATIONS & TRACERS STATE ---
const activeBullets = [];
let localWeaponAnimTime = 0;
let localWeaponAnimDuration = 0;
let localWeaponAnimType = null; // 'swing' or 'recoil'

function triggerLocalWeaponAnimation(type) {
  localWeaponAnimType = type;
  localWeaponAnimTime = 0;
  if (type === 'swing') {
    localWeaponAnimDuration = 0.2;
  } else if (type === 'recoil') {
    localWeaponAnimDuration = 0.12;
  }
}

function triggerThirdPersonAnimation(id, type) {
  const obj = otherPlayers[id];
  if (!obj || !obj.weaponMesh) return;
  obj.animType = type;
  obj.animTime = 0;
  obj.animDuration = (type === 'stab') ? 0.2 : 0.12;
}

// --- PRELOAD GLB MODELS & NORMALIZATION ---
const gltfLoader = new GLTFLoader();
let preloadedKatana = null;
let preloadedGun = null;

// Helper to center pivot and scale arbitrary models to a standard size, with optional rotation correction
function normalizeModel(name, modelScene, targetSize, rotationCorrection = null) {
  // Apply rotation correction first if provided
  if (rotationCorrection) {
    modelScene.rotation.copy(rotationCorrection);
    modelScene.updateMatrixWorld(true);
  }

  const box = new THREE.Box3().setFromObject(modelScene);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  
  console.log(`[GLB Debug - ${name}] Size:`, size, `Center:`, center);

  const wrapper = new THREE.Group();
  modelScene.position.sub(center); // Center geometry to pivot
  wrapper.add(modelScene);
  
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 0) {
    const scale = targetSize / maxDim;
    wrapper.scale.set(scale, scale, scale);
    console.log(`[GLB Debug - ${name}] Scale factor applied:`, scale);
  }
  return wrapper;
}

gltfLoader.load('katana.glb', (gltf) => {
  const rot = new THREE.Euler(0, -Math.PI / 2, 0); // Rotate 90 deg around Y to point forward
  preloadedKatana = normalizeModel('Katana', gltf.scene, 1.2, rot); // standard 1.2 units length
  preloadedKatana.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  console.log('Katana GLB model loaded successfully [v1.0.3]');
}, undefined, (err) => console.error('Failed to load Katana GLB:', err));

gltfLoader.load('gun.glb', (gltf) => {
  const rot = new THREE.Euler(0, -Math.PI / 2, 0); // Rotate 90 deg around Y to point forward
  preloadedGun = normalizeModel('Gun', gltf.scene, 0.45, rot); // standard 0.45 units size (increased)
  preloadedGun.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  console.log('Gun GLB model loaded successfully');
}, undefined, (err) => console.error('Failed to load Gun GLB:', err));

// --------------------------------------------------------
// THREE.JS SETUP
// --------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb); // Sky blue
scene.fog = new THREE.Fog(0x87ceeb, 10, 50);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.y = 1.6; // Player height
scene.add(camera); // Required so that children of the camera (like FPV weapons) are rendered!

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(10, 20, 10);
dirLight.castShadow = true;
scene.add(dirLight);

// Ground
const groundGeo = new THREE.PlaneGeometry(100, 100);
const ground = new THREE.Mesh(groundGeo, null); // material assigned below
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// --- MAP GENERATION & TEXTURES ---
const textureLoader = new THREE.TextureLoader();

// Load textures locally from the public directory (resolves CORS and 404s)
const grassTexture = textureLoader.load('grass.jpg');
grassTexture.wrapS = THREE.RepeatWrapping;
grassTexture.wrapT = THREE.RepeatWrapping;
grassTexture.repeat.set(15, 15);

const woodTexture = textureLoader.load('wood.jpg');
woodTexture.wrapS = THREE.RepeatWrapping;
woodTexture.wrapT = THREE.RepeatWrapping;
woodTexture.repeat.set(8, 5);

const brickTexture = textureLoader.load('brick.jpg');
brickTexture.wrapS = THREE.RepeatWrapping;
brickTexture.wrapT = THREE.RepeatWrapping;

const brickBumpTexture = textureLoader.load('brick_bump.jpg');
brickBumpTexture.wrapS = THREE.RepeatWrapping;
brickBumpTexture.wrapT = THREE.RepeatWrapping;

// Materials
const groundMat = new THREE.MeshStandardMaterial({ map: grassTexture, roughness: 1.0 });
ground.material = groundMat; // Assign grass to yard

const floorMatInner = new THREE.MeshStandardMaterial({ map: woodTexture, roughness: 0.5 });
const basementFloorMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 }); // dark concrete look
const wallMat = new THREE.MeshStandardMaterial({ color: 0xf3ede3, roughness: 0.95 }); // Plaster eggshell drywall
const outerWallMat = new THREE.MeshStandardMaterial({ map: brickTexture, bumpMap: brickBumpTexture, bumpScale: 0.04, roughness: 0.8 });
const basementWallMat = new THREE.MeshStandardMaterial({ map: brickTexture, bumpMap: brickBumpTexture, bumpScale: 0.04, color: 0x444444, roughness: 0.9 }); // Dark brick
const fenceMat = new THREE.MeshStandardMaterial({ color: 0x4a3b32, roughness: 0.9 }); // Wood Fence

// Ground inside house (X: -25 to 25, Z: -25 to 5)
const houseFloorGeo = new THREE.PlaneGeometry(50, 30);
const houseFloor = new THREE.Mesh(houseFloorGeo, floorMatInner);
houseFloor.rotation.x = -Math.PI / 2;
houseFloor.position.set(0, 0.01, -10);
houseFloor.receiveShadow = true;
scene.add(houseFloor);

// Basement Floor (Y: -20, X: -15 to 15, Z: -15 to 15)
const basementFloorGeo = new THREE.PlaneGeometry(30, 30);
const basementFloor = new THREE.Mesh(basementFloorGeo, basementFloorMat);
basementFloor.rotation.x = -Math.PI / 2;
basementFloor.position.set(0, -20, 0);
basementFloor.receiveShadow = true;
scene.add(basementFloor);

// Basement Ceiling
const basementCeilingGeo = new THREE.PlaneGeometry(30, 30);
const basementCeiling = new THREE.Mesh(basementCeilingGeo, basementFloorMat);
basementCeiling.rotation.x = Math.PI / 2; // facing down
basementCeiling.position.set(0, -12, 0);
scene.add(basementCeiling);

function createWall(x, z, w, d, h = 5, y = 2.5, material = wallMat) {
  const geo = new THREE.BoxGeometry(w, h, d);
  
  // Custom texture tiling per wall size to prevent stretching
  let mat = material;
  if (material.map) {
    mat = material.clone();
    const size = w > d ? w : d;
    mat.map = material.map.clone();
    mat.map.needsUpdate = true;
    mat.map.repeat.set(size / 3, h / 3);
    if (material.bumpMap) {
      mat.bumpMap = material.bumpMap.clone();
      mat.bumpMap.needsUpdate = true;
      mat.bumpMap.repeat.set(size / 3, h / 3);
    }
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

// 1. Outer Boundaries
createWall(0, -25, 50, 1, 5, 2.5, outerWallMat); // Front Wall
createWall(-25, -10, 1, 30, 5, 2.5, outerWallMat); // Left Wall
createWall(25, -10, 1, 30, 5, 2.5, outerWallMat); // Right Wall
createWall(-25, 15, 1, 20, 3, 1.5, fenceMat); // Left Fence
createWall(25, 15, 1, 20, 3, 1.5, fenceMat); // Right Fence
createWall(0, 25, 50, 1, 3, 1.5, fenceMat); // Back Fence

// Separator between House and Backyard (Z = 5)
createWall(-15, 5, 20, 1, 5, 2.5, outerWallMat); // Left
createWall(15, 5, 20, 1, 5, 2.5, outerWallMat); // Right
createWall(-3, 5, 4, 1, 5, 2.5, outerWallMat); // Glass door left
createWall(3, 5, 4, 1, 5, 2.5, outerWallMat); // Glass door right (leaves door at X:0)

// 2. Interior Rooms (Logical Layout)
// Left side separating wall (X = -8, Z: -25 to 5)
createWall(-8, -22, 1, 6); // Wall segment 1
// (Gap at Z = -17.5 for Laundry Room Door, width 3)
createWall(-8, -10, 1, 12); // Wall segment 2
// (Gap at Z = -2.5 for Master Bed Door, width 3)
createWall(-8, 2, 1, 6); // Wall segment 3

// Left side horizontal partition (Z = -10, X: -25 to -8)
createWall(-23.5, -10, 3, 1); // Partition segment 1
// (Gap at X = -20.5 for Master Bathroom Door, width 3)
createWall(-13.5, -10, 11, 1); // Partition segment 2

// Master Bath & Laundry Room separator (X = -15, Z: -25 to -10)
createWall(-15, -17.5, 1, 15);

// Right side separating wall (X = 8, Z: -25 to 5)
createWall(8, -23.25, 1, 3.5); // Wall segment 1
// (Gap at Z = -20 for Hall Bath Door, width 3)
createWall(8, -15, 1, 7); // Wall segment 2
// (Gap at Z = -10 for Bedroom 2 Door, width 3)
createWall(8, -5, 1, 7); // Wall segment 3
// (Gap at Z = 0 for Bedroom 1 Door, width 3)
createWall(8, 3.25, 1, 3.5); // Wall segment 4

// Right side partitions (solid separators)
createWall(16.5, -5, 17, 1); // Separates Bed 1 and Bed 2
createWall(16.5, -15, 17, 1); // Separates Bed 2 and Hall Bath

// Basement Hatch Visual
const hatchGeo = new THREE.BoxGeometry(3, 0.1, 3);
const hatchMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
const hatch = new THREE.Mesh(hatchGeo, hatchMat);
hatch.position.set(0, 0.02, -10); // Placed in the center of the living room
scene.add(hatch);

// Basement Walls (Y: -20, concrete)
createWall(0, -15, 30, 1, 8, -16, basementWallMat);
createWall(0, 15, 30, 1, 8, -16, basementWallMat);
createWall(-15, 0, 1, 30, 8, -16, basementWallMat);
createWall(15, 0, 1, 30, 8, -16, basementWallMat);

// Basement Exit Ladder
const ladderGeo = new THREE.BoxGeometry(1, 8, 0.2);
const ladderMat = new THREE.MeshStandardMaterial({ color: 0x777777, metalness: 0.8 });
const ladder = new THREE.Mesh(ladderGeo, ladderMat);
ladder.position.set(0, -16, -14.8);
scene.add(ladder);

// --------------------------------------------------------
// CONTROLS & MOVEMENT
// --------------------------------------------------------
const controls = new PointerLockControls(camera, document.body);

let moveForward = false;
let moveBackward = false;
let moveLeft = false;
let moveRight = false;
let canJump = false;

const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
const speed = 40;
let prevTime = performance.now();

document.addEventListener('keydown', (event) => {
  if (isDead || isStunned || !hasJoined) return;
  switch (event.code) {
    case 'ArrowUp':
    case 'KeyW': moveForward = true; break;
    case 'ArrowLeft':
    case 'KeyA': moveLeft = true; break;
    case 'ArrowDown':
    case 'KeyS': moveBackward = true; break;
    case 'ArrowRight':
    case 'KeyD': moveRight = true; break;
    case 'Space': if (canJump === true) velocity.y += 10; canJump = false; break;
    case 'Digit1':
      if (gameState === 'playing' && myRole !== 'innocent' && myRole !== 'spectator' && myRole !== 'unassigned') {
        isEquipped = !isEquipped;
        socket.emit('toggleEquip', isEquipped);
        updateLocalEquipVisual();
      }
      break;
  }
});

document.addEventListener('keyup', (event) => {
  switch (event.code) {
    case 'ArrowUp':
    case 'KeyW': moveForward = false; break;
    case 'ArrowLeft':
    case 'KeyA': moveLeft = false; break;
    case 'ArrowDown':
    case 'KeyS': moveBackward = false; break;
    case 'ArrowRight':
    case 'KeyD': moveRight = false; break;
  }
});

// Raycaster for aiming abilities
const raycaster = new THREE.Raycaster();

document.addEventListener('mousedown', (event) => {
  if (gameState !== 'playing' || isDead || isStunned || !hasJoined) return;
  if (myRole === 'unassigned' || myRole === 'innocent') return;
  if (!isEquipped) return; // Must have weapon equipped to use it

  if (controls.isLocked) {
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const intersects = raycaster.intersectObjects(scene.children);
    
    let targetId = null;
    for (const intersect of intersects) {
      if (intersect.object.userData && intersect.object.userData.id) {
        targetId = intersect.object.userData.id;
        break;
      }
    }

    let actionType = '';
    if (myRole === 'murderer') actionType = 'stab';
    if (myRole === 'sheriff') actionType = 'shoot';
    if (myRole === 'taser') actionType = 'tase';
    if (myRole === 'clown') actionType = 'pie';

    if (actionType === 'stab' && targetId) {
      const dist = camera.position.distanceTo(otherPlayers[targetId].mesh.position);
      if (dist > 3) return; // Too far
    }

    // Trigger local animation immediately for responsive feel
    if (myRole === 'murderer') {
      triggerLocalWeaponAnimation('swing');
    } else if (myRole === 'sheriff') {
      triggerLocalWeaponAnimation('recoil');
    }

    if (actionType) {
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);

      socket.emit('action', {
        type: actionType,
        targetId: targetId,
        origin: {
          x: camera.position.x,
          y: camera.position.y - 0.25,
          z: camera.position.z
        },
        dir: {
          x: dir.x,
          y: dir.y,
          z: dir.z
        }
      });
    }
  }
});

// UI Event Listeners
document.getElementById('lobby-screen').addEventListener('click', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
  if (gameState === 'playing' && hasJoined) controls.lock();
});

document.addEventListener('click', () => {
  if (gameState === 'playing' && !isDead && !controls.isLocked && hasJoined) {
    controls.lock();
  }
});

// Name submission
document.getElementById('join-btn').addEventListener('click', () => {
  const nameInput = document.getElementById('username-input').value.trim();
  if (nameInput) {
    socket.emit('join', { name: nameInput });
    hasJoined = true;
    document.getElementById('login-form').classList.add('hidden');
    document.getElementById('lobby-details').classList.remove('hidden');
  }
});

// Mode buttons
document.getElementById('btn-mode-standard').addEventListener('click', () => {
  socket.emit('setGameMode', 'standard');
});
document.getElementById('btn-mode-extended').addEventListener('click', () => {
  socket.emit('setGameMode', 'extended');
});

// --------------------------------------------------------
// WEAPON / ITEM MESH HELPERS
// --------------------------------------------------------

function createItemModel(role) {
  if (role === 'murderer') {
    if (preloadedKatana) {
      return preloadedKatana.clone();
    }
    const group = new THREE.Group();
    // Blade
    const bladeGeo = new THREE.BoxGeometry(0.02, 0.6, 0.005);
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.9, roughness: 0.1 });
    const blade = new THREE.Mesh(bladeGeo, bladeMat);
    blade.position.y = 0.3;
    group.add(blade);
    // Handle
    const handleGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.15);
    const handleMat = new THREE.MeshStandardMaterial({ color: 0x990000 }); // Red grip
    const handle = new THREE.Mesh(handleGeo, handleMat);
    handle.position.y = -0.075;
    group.add(handle);
    group.rotation.x = Math.PI / 2;
    return group;
  }
  if (role === 'sheriff') {
    if (preloadedGun) {
      return preloadedGun.clone();
    }
    const group = new THREE.Group();
    // Barrel
    const barrelGeo = new THREE.BoxGeometry(0.03, 0.03, 0.15);
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.8 });
    const barrel = new THREE.Mesh(barrelGeo, barrelMat);
    barrel.position.z = -0.05;
    group.add(barrel);
    // Grip
    const gripGeo = new THREE.BoxGeometry(0.025, 0.07, 0.025);
    const grip = new THREE.Mesh(gripGeo, barrelMat);
    grip.position.set(0, -0.04, 0.03);
    grip.rotation.x = -Math.PI / 6;
    group.add(grip);
    return group;
  }
  if (role === 'taser') {
    const group = new THREE.Group();
    // Taser Body
    const bodyGeo = new THREE.BoxGeometry(0.05, 0.05, 0.12);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xccaa00 }); // Yellow taser body
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    group.add(body);
    // Prongs
    const prongGeo = new THREE.BoxGeometry(0.01, 0.01, 0.03);
    const prongMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
    const p1 = new THREE.Mesh(prongGeo, prongMat);
    p1.position.set(0.015, 0, -0.075);
    const p2 = new THREE.Mesh(prongGeo, prongMat);
    p2.position.set(-0.015, 0, -0.075);
    group.add(p1, p2);
    return group;
  }
  if (role === 'clown') {
    const group = new THREE.Group();
    // Pie crust
    const crustGeo = new THREE.CylinderGeometry(0.08, 0.07, 0.02, 10);
    const crustMat = new THREE.MeshStandardMaterial({ color: 0xc68e5c });
    const crust = new THREE.Mesh(crustGeo, crustMat);
    group.add(crust);
    // Whipped cream
    const creamGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.015, 10);
    const creamMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0 });
    const cream = new THREE.Mesh(creamGeo, creamMat);
    cream.position.y = 0.01;
    group.add(cream);
    group.rotation.x = Math.PI / 2;
    return group;
  }
  return null;
}

function updateLocalEquipVisual() {
  const hint = document.getElementById('action-hint');
  if (!hint) return;

  if (myRole === 'innocent' || myRole === 'spectator' || myRole === 'unassigned') {
    hint.innerText = '';
    if (localWeaponMesh) camera.remove(localWeaponMesh);
    return;
  }

  let weaponName = '';
  if (myRole === 'murderer') weaponName = 'Katana';
  if (myRole === 'sheriff') weaponName = 'Gun';
  if (myRole === 'taser') weaponName = 'Taser';
  if (myRole === 'clown') weaponName = 'Pie';

  if (isEquipped) {
    hint.innerText = `[1] Unequip | Left Click to Use ${weaponName}`;
    if (localWeaponMesh) {
      camera.add(localWeaponMesh);
      // Position model further forward and centered in front of camera view (X: 0.1, Z: -0.8, Rot: 0,0,0)
      if (myRole === 'murderer') {
        localWeaponMesh.position.set(0.1, -0.2, -0.8);
        localWeaponMesh.rotation.set(0, 0, 0);
      } else if (myRole === 'sheriff') {
        localWeaponMesh.position.set(0.1, -0.15, -0.6);
        localWeaponMesh.rotation.set(0, 0, 0);
      } else {
        localWeaponMesh.position.set(0.1, -0.15, -0.6);
        localWeaponMesh.rotation.set(0, 0, 0);
      }
    }
  } else {
    hint.innerText = `Press [1] to Equip ${weaponName} (Hidden)`;
    if (localWeaponMesh) {
      camera.remove(localWeaponMesh);
    }
  }
}

function updatePlayerEquipVisual(id) {
  const obj = otherPlayers[id];
  if (!obj) return;

  if (obj.weaponMesh) {
    obj.mesh.remove(obj.weaponMesh);
    obj.weaponMesh = null;
  }

  if (obj.data.isEquipped && !obj.data.isDead) {
    obj.weaponMesh = createItemModel(obj.data.role);
    if (obj.weaponMesh) {
      obj.mesh.add(obj.weaponMesh);
      // Position further forward relative to the other player's capsule (Z: -0.9, Y: 0.2 for hand level)
      obj.weaponMesh.position.set(0.4, 0.2, -0.9);
      obj.weaponMesh.rotation.set(0, 0, 0);
    }
  }
}

// --------------------------------------------------------
// SOCKET EVENT LISTENERS
// --------------------------------------------------------

function updatePlayerMesh(id, pData) {
  const playerColor = pData.color !== undefined ? pData.color : 0xff3b3b;
  if (!otherPlayers[id]) {
    // Create new player mesh
    const geo = new THREE.CapsuleGeometry(0.5, 1, 4, 8);
    const mat = new THREE.MeshStandardMaterial({ color: playerColor });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pData.x, pData.y + 1, pData.z);
    mesh.rotation.y = pData.ry;
    mesh.userData = { id: id };
    mesh.castShadow = true;
    scene.add(mesh);
    otherPlayers[id] = { mesh, data: pData, weaponMesh: null };
  } else {
    // Update existing
    const obj = otherPlayers[id];
    obj.data = pData;
    
    if (pData.isDead) {
      obj.mesh.rotation.z = Math.PI / 2; // Lie down
      obj.mesh.position.y = pData.y + 0.5;
    } else {
      obj.mesh.position.set(pData.x, pData.y + 1, pData.z);
      obj.mesh.rotation.y = pData.ry;
      obj.mesh.rotation.z = 0;
    }
    
    // Status visual effects
    if (pData.isStunned) obj.mesh.material.color.setHex(0xffff00);
    else if (pData.isDead) obj.mesh.material.color.setHex(0x555555);
    else obj.mesh.material.color.setHex(playerColor);
  }

  // Update equip visual
  updatePlayerEquipVisual(id);
}

socket.on('init', (data) => {
  myId = data.id;
  gameState = data.gameState;
  gameMode = data.gameMode;
  
  updateGameModeUI(gameMode);
  
  for (const id in data.players) {
    playerRegistry[id] = data.players[id];
    if (id !== myId && data.players[id].hasJoined) {
      updatePlayerMesh(id, data.players[id]);
    } else if (id === myId) {
      camera.position.set(data.players[id].x, data.players[id].y + 1.6, data.players[id].z);
    }
  }
  updateLobbyPlayersList();
  updateUI();
});

socket.on('playerJoined', (pData) => {
  playerRegistry[pData.id] = pData;
  if (pData.id !== myId) {
    updatePlayerMesh(pData.id, pData);
  }
  updateLobbyPlayersList();
});

socket.on('playerMoved', (pData) => {
  playerRegistry[pData.id] = pData;
  if (pData.id !== myId) updatePlayerMesh(pData.id, pData);
});

socket.on('stateUpdate', (players) => {
  for (const id in players) {
    playerRegistry[id] = players[id];
    if (id !== myId) {
      updatePlayerMesh(id, players[id]);
    } else {
      const myData = players[id];
      if (myData.y === 1 && Math.abs(myData.x - camera.position.x) > 1) {
        camera.position.set(myData.x, myData.y + 0.6, myData.z);
      }
    }
  }
  updateLobbyPlayersList();
});

socket.on('gameModeUpdated', (mode) => {
  gameMode = mode;
  updateGameModeUI(gameMode);
});

socket.on('playerEquipUpdated', (data) => {
  if (otherPlayers[data.id]) {
    otherPlayers[data.id].data.isEquipped = data.isEquipped;
    updatePlayerEquipVisual(data.id);
  }
});

socket.on('gameStarted', (data) => {
  gameState = 'playing';
  myRole = data.role;
  isDead = false;
  isStunned = false;
  isBlinded = false;
  isEquipped = false;

  // Setup local weapon mesh
  if (localWeaponMesh) camera.remove(localWeaponMesh);
  localWeaponMesh = createItemModel(myRole);
  updateLocalEquipVisual();
  
  document.getElementById('lobby-screen').classList.add('hidden');
  document.getElementById('role-reveal-screen').classList.remove('hidden');
  document.getElementById('game-over-screen').classList.add('hidden');
  document.getElementById('dead-overlay').classList.add('hidden');
  document.getElementById('stun-overlay').classList.add('hidden');
  document.getElementById('blind-overlay').classList.add('hidden');
  
  let roleTitle = '';
  let roleDesc = '';
  let color = 'white';
  
  switch(myRole) {
    case 'murderer': 
      roleTitle = 'MURDERER'; 
      roleDesc = 'Press [1] to Equip Katana. Click near players to stab.'; 
      color = '#ff3b3b';
      break;
    case 'sheriff': 
      roleTitle = 'SHERIFF'; 
      roleDesc = 'Press [1] to Equip Gun. Shoot the Murderer, spare innocents.'; 
      color = '#3b82f6';
      break;
    case 'taser': 
      roleTitle = 'TASER'; 
      roleDesc = 'Press [1] to Equip Taser. Tase and stun anyone for 5s.'; 
      color = '#eab308';
      break;
    case 'clown': 
      roleTitle = 'CLOWN'; 
      roleDesc = 'Press [1] to Equip Pie. Throw pie and blind anyone for 5s.'; 
      color = '#d946ef';
      break;
    case 'spectator':
      roleTitle = 'SPECTATOR';
      roleDesc = 'You joined late. Spectating this round.';
      color = '#aaaaaa';
      isDead = true;
      break;
    default:
      roleTitle = 'INNOCENT'; 
      roleDesc = 'Survive and figure out who the Murderer is.'; 
      color = '#22c55e';
  }
  
  document.getElementById('role-title').innerText = roleTitle;
  document.getElementById('role-title').style.color = color;
  document.getElementById('role-desc').innerText = roleDesc;
  
  document.querySelector('#current-role span').innerText = roleTitle;
  document.querySelector('#current-role span').style.color = color;
  
  setTimeout(() => {
    if (gameState === 'playing') {
      document.getElementById('role-reveal-screen').classList.add('hidden');
      if (myRole !== 'spectator') {
        document.getElementById('hud').classList.remove('hidden');
        controls.lock();
      } else {
        document.getElementById('dead-overlay').classList.remove('hidden');
        document.querySelector('#dead-overlay h2').innerText = 'SPECTATING...';
      }
    }
  }, 4000);
});

socket.on('timerUpdate', (time) => {
  if (gameState === 'lobby') {
    document.getElementById('lobby-timer').innerText = time;
  } else {
    document.getElementById('game-timer').innerText = time;
  }
});

socket.on('playerDied', (id) => {
  if (id === myId) {
    isDead = true;
    isEquipped = false;
    if (localWeaponMesh) camera.remove(localWeaponMesh);
    updateLocalEquipVisual();
    controls.unlock();
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('dead-overlay').classList.remove('hidden');
    document.querySelector('#dead-overlay h2').innerText = 'YOU DIED';
  } else if (otherPlayers[id]) {
    otherPlayers[id].data.isDead = true;
    updatePlayerMesh(id, otherPlayers[id].data);
  }
});

socket.on('statusUpdate', (data) => {
  if (data.id === myId) {
    if (data.status === 'isStunned') {
      isStunned = data.value;
      if (isStunned) {
        document.getElementById('stun-overlay').classList.remove('hidden');
        // Force unequip if stunned
        isEquipped = false;
        socket.emit('toggleEquip', false);
        updateLocalEquipVisual();
      } else {
        document.getElementById('stun-overlay').classList.add('hidden');
      }
    }
    if (data.status === 'isBlinded') {
      isBlinded = data.value;
      if (isBlinded) {
        document.getElementById('blind-overlay').classList.remove('hidden');
      } else {
        document.getElementById('blind-overlay').classList.add('hidden');
      }
    }
  } else if (otherPlayers[data.id]) {
    otherPlayers[data.id].data[data.status] = data.value;
    updatePlayerMesh(data.id, otherPlayers[data.id].data);
  }
});

socket.on('gameOver', (data) => {
  gameState = 'lobby';
  isEquipped = false;
  if (localWeaponMesh) camera.remove(localWeaponMesh);
  controls.unlock();
  
  document.getElementById('hud').classList.add('hidden');
  document.getElementById('dead-overlay').classList.add('hidden');
  document.getElementById('stun-overlay').classList.add('hidden');
  document.getElementById('blind-overlay').classList.add('hidden');
  
  document.getElementById('game-over-screen').classList.remove('hidden');
  
  const winnerText = data.winner === 'murderer' ? 'MURDERER WINS!' : 'INNOCENTS WIN!';
  const wColor = data.winner === 'murderer' ? '#ff3b3b' : '#22c55e';
  
  document.getElementById('winner-text').innerText = winnerText;
  document.getElementById('winner-text').style.color = wColor;
});

socket.on('revealRoles', (playersObj) => {
  const list = document.getElementById('reveal-list');
  list.innerHTML = '';
  for (const id in playersObj) {
    const p = playersObj[id];
    if (p.hasJoined) {
      let name = id === myId ? 'You' : p.name;
      list.innerHTML += `<div>${name} was the <span style="color: yellow">${p.role}</span></div>`;
    }
  }
  
  setTimeout(() => {
    document.getElementById('game-over-screen').classList.add('hidden');
    document.getElementById('lobby-screen').classList.remove('hidden');
  }, 5000);
});

socket.on('playerLeft', (id) => {
  delete playerRegistry[id];
  if (otherPlayers[id]) {
    scene.remove(otherPlayers[id].mesh);
    delete otherPlayers[id];
  }
  updateLobbyPlayersList();
});

socket.on('weaponFired', (data) => {
  // Spawning tracers for bullets
  if (data.type === 'shoot' || data.type === 'tase') {
    const isTaser = data.type === 'tase';
    const bulletGeo = new THREE.SphereGeometry(isTaser ? 0.08 : 0.05, 8, 8);
    const bulletMat = new THREE.MeshBasicMaterial({ color: isTaser ? 0x00ffff : 0xffe600 }); // yellow for gun, cyan for taser
    const bulletMesh = new THREE.Mesh(bulletGeo, bulletMat);
    
    let startPos = new THREE.Vector3();
    let velocityVec = new THREE.Vector3(data.dir.x, data.dir.y, data.dir.z).normalize().multiplyScalar(90); // 90 units/sec
    
    if (data.playerId === myId) {
      startPos.set(camera.position.x, camera.position.y - 0.25, camera.position.z);
    } else {
      startPos.set(data.origin.x, data.origin.y, data.origin.z);
    }
    
    bulletMesh.position.copy(startPos);
    scene.add(bulletMesh);
    
    activeBullets.push({
      mesh: bulletMesh,
      velocity: velocityVec,
      life: 0.8 // 800ms life
    });
  }
  
  // Play animations for other players
  if (data.playerId !== myId) {
    if (data.type === 'stab' || data.type === 'pie') {
      triggerThirdPersonAnimation(data.playerId, 'stab');
    } else if (data.type === 'shoot' || data.type === 'tase') {
      triggerThirdPersonAnimation(data.playerId, 'shoot');
    }
  }
});

function updateUI() {
  if (gameState === 'lobby') {
    document.getElementById('lobby-screen').classList.remove('hidden');
    document.getElementById('hud').classList.add('hidden');
  } else {
    document.getElementById('lobby-screen').classList.add('hidden');
  }
}

function updateGameModeUI(mode) {
  if (mode === 'standard') {
    document.getElementById('btn-mode-standard').classList.add('active');
    document.getElementById('btn-mode-extended').classList.remove('active');
  } else {
    document.getElementById('btn-mode-standard').classList.remove('active');
    document.getElementById('btn-mode-extended').classList.add('active');
  }
}

function updateLobbyPlayersList() {
  const list = document.getElementById('players-list');
  if (!list) return;
  list.innerHTML = '';
  for (const id in playerRegistry) {
    const p = playerRegistry[id];
    if (p.hasJoined) {
      list.innerHTML += `<div>${p.name}</div>`;
    }
  }
}

// --------------------------------------------------------
// RENDER LOOP
// --------------------------------------------------------

const tempV = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);

  const time = performance.now();
  const delta = (time - prevTime) / 1000;

  if (controls.isLocked === true && !isDead && !isStunned && hasJoined) {
    raycaster.ray.origin.copy(camera.position);
    raycaster.ray.origin.y -= 1; // From feet

    // Basic ground collision
    let onObject = camera.position.y <= 1.6;

    velocity.x -= velocity.x * 10.0 * delta;
    velocity.z -= velocity.z * 10.0 * delta;
    velocity.y -= 9.8 * 20.0 * delta; // falling

    direction.z = Number(moveForward) - Number(moveBackward);
    direction.x = Number(moveRight) - Number(moveLeft);
    direction.normalize();

    if (moveForward || moveBackward) velocity.z -= direction.z * speed * delta;
    if (moveLeft || moveRight) velocity.x -= direction.x * speed * delta;

    if (onObject === true) {
      velocity.y = Math.max(0, velocity.y);
      canJump = true;
    }

    controls.moveRight(-velocity.x * delta);
    controls.moveForward(-velocity.z * delta);
    camera.position.y += (velocity.y * delta);

    // Teleporter checks
    const playerPos = camera.position;
    if (playerPos.y > -10) {
      const distToHatch = playerPos.distanceTo(new THREE.Vector3(0, playerPos.y, -10));
      if (distToHatch < 1.5) {
        camera.position.set(0, -20 + 1.6, -12);
      }
    } else {
      const distToLadder = playerPos.distanceTo(new THREE.Vector3(0, playerPos.y, -14));
      if (distToLadder < 1.5) {
        camera.position.set(0, 1.6, -12);
      }
    }

    let floorY = 0;
    let minX = -24, maxX = 24, minZ = -24, maxZ = 24;

    if (camera.position.y < -10) {
      floorY = -20;
      minX = -14; maxX = 14;
      minZ = -14; maxZ = 14;
    }

    if (camera.position.y < floorY + 1.6) {
      velocity.y = 0;
      camera.position.y = floorY + 1.6;
      canJump = true;
    }

    // Limit boundaries
    if (camera.position.x < minX) camera.position.x = minX;
    if (camera.position.x > maxX) camera.position.x = maxX;
    if (camera.position.z < minZ) camera.position.z = minZ;
    if (camera.position.z > maxZ) camera.position.z = maxZ;

    // Send position to server periodically or if moved
    if (Math.abs(velocity.x) > 0.1 || Math.abs(velocity.z) > 0.1 || Math.abs(velocity.y) > 0.1) {
      socket.emit('move', {
        x: camera.position.x,
        y: camera.position.y - 1.6, // send feet pos
        z: camera.position.z,
        ry: camera.rotation.y
      });
    }
  }

  // Name tags disabled

  // --- UPDATE WEAPON ANIMATIONS ---
  if (localWeaponAnimType && localWeaponMesh) {
    localWeaponAnimTime += delta;
    const t = Math.min(localWeaponAnimTime / localWeaponAnimDuration, 1.0);
    
    if (localWeaponAnimType === 'swing') {
      if (t < 0.5) {
        const p = t / 0.5;
        localWeaponMesh.position.set(0.1 - 0.2 * p, -0.2 - 0.15 * p, -0.8 - 0.2 * p);
        localWeaponMesh.rotation.set(-1.2 * p, -0.6 * p, -0.3 * p);
      } else {
        const p = (t - 0.5) / 0.5;
        localWeaponMesh.position.set(-0.1 + 0.2 * p, -0.35 + 0.15 * p, -1.0 + 0.2 * p);
        localWeaponMesh.rotation.set(-1.2 * (1 - p), -0.6 * (1 - p), -0.3 * (1 - p));
      }
    } else if (localWeaponAnimType === 'recoil') {
      if (t < 0.2) {
        const p = t / 0.2;
        localWeaponMesh.position.set(0.25, -0.2 + 0.08 * p, -0.9 + 0.2 * p); // kick back on Z (positive is towards camera)
        localWeaponMesh.rotation.set(0.5 * p, 0, 0); // tilt muzzle up
      } else {
        const p = (t - 0.2) / 0.8;
        localWeaponMesh.position.set(0.25, -0.12 - 0.08 * p, -0.7 - 0.2 * p);
        localWeaponMesh.rotation.set(0.5 * (1 - p), 0, 0);
      }
    }
    
    if (localWeaponAnimTime >= localWeaponAnimDuration) {
      localWeaponAnimType = null;
      // Reset to exact idle positions
      if (myRole === 'murderer') {
        localWeaponMesh.position.set(0.1, -0.2, -0.8);
      } else {
        localWeaponMesh.position.set(0.25, -0.2, -0.9); // Gun default position
      }
      localWeaponMesh.rotation.set(0, 0, 0);
    }
  }

  // Other players third-person animations
  for (const id in otherPlayers) {
    const obj = otherPlayers[id];
    if (obj.animType && obj.weaponMesh) {
      obj.animTime += delta;
      const t = Math.min(obj.animTime / obj.animDuration, 1.0);
      
      if (obj.animType === 'stab') {
        // Swing weapon forward and down
        if (t < 0.5) {
          const p = t / 0.5;
          obj.weaponMesh.rotation.set(1.2 * p, 0, 0);
        } else {
          const p = (t - 0.5) / 0.5;
          obj.weaponMesh.rotation.set(1.2 * (1 - p), 0, 0);
        }
      } else if (obj.animType === 'shoot') {
        // Kick recoil
        if (t < 0.2) {
          const p = t / 0.2;
          obj.weaponMesh.position.set(0.4, 0.2 + 0.1 * p, -0.9 + 0.15 * p);
          obj.weaponMesh.rotation.set(0.5 * p, 0, 0);
        } else {
          const p = (t - 0.2) / 0.8;
          obj.weaponMesh.position.set(0.4, 0.3 - 0.1 * p, -0.75 - 0.15 * p);
          obj.weaponMesh.rotation.set(0.5 * (1 - p), 0, 0);
        }
      }
      
      if (obj.animTime >= obj.animDuration) {
        obj.animType = null;
        obj.weaponMesh.position.set(0.4, 0.2, -0.9);
        obj.weaponMesh.rotation.set(0, 0, 0);
      }
    }
  }

  // --- UPDATE TRACERS / BULLETS ---
  for (let i = activeBullets.length - 1; i >= 0; i--) {
    const bullet = activeBullets[i];
    bullet.mesh.position.addScaledVector(bullet.velocity, delta);
    bullet.life -= delta;
    if (bullet.life <= 0) {
      scene.remove(bullet.mesh);
      activeBullets.splice(i, 1);
    }
  }

  prevTime = time;
  renderer.render(scene, camera);
}

window.addEventListener('resize', onWindowResize);

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

animate();
