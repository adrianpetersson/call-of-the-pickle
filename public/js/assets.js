// Loads the Blender-made models (see tools/blender/build_assets.py) once at boot.
import { GLTFLoader } from '../vendor/loaders/GLTFLoader.js';

const FILES = ['pickle', 'rattler', 'scatter', 'longshot', 'thumper', 'sidearm', 'jar', 'bomb', 'pickups', 'props', 'blocks', 'xmas'];
export const models = {};

export async function loadModels() {
  const loader = new GLTFLoader();
  await Promise.all(FILES.map(async (name) => {
    const gltf = await loader.loadAsync(`assets/models/${name}.glb`);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      if (m.name === 'JarGlass') { m.transparent = true; m.opacity = 0.5; m.depthWrite = false; }
      m.metalness = 0;
    });
    models[name] = gltf.scene;
  }));
}

// Which model file holds a named prop (the holiday set lives in its own file).
export function propFile(name) {
  return models.props.getObjectByName(name) ? 'props' : 'xmas';
}

// A copy of one named object from a model file, placed at the origin.
// Meshes using the "Tint" material get `tint` instead, so each player can have their own colour.
export function part(file, name, tint) {
  const src = name ? models[file].getObjectByName(name) : models[file];
  const o = src.clone(true);
  o.position.set(0, 0, 0);
  if (tint) o.traverse((m) => { if (m.isMesh && m.material.name === 'Tint') m.material = tint; });
  return o;
}
