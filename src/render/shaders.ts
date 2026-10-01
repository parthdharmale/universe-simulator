/**
 * GLSL sources. Shaders are written for WebGL2 (GLSL ES 3.00 via three.js's
 * ShaderMaterial translation). Integer hashing requires highp uint.
 */

/** Must stay bit-compatible with src/engine/gen/terrain.ts. */
export const NOISE_GLSL = /* glsl */ `
float latticeHash(ivec3 i, uint seed) {
  uint h = (uint(i.x) * 0x8da6b343u) ^ (uint(i.y) * 0xd8163841u) ^ (uint(i.z) * 0xcb1ab31fu) ^ seed;
  h ^= h >> 16u; h *= 0x7feb352du; h ^= h >> 15u; h *= 0x846ca68bu; h ^= h >> 16u;
  return float(h) / 4294967296.0;
}
float vnoise(vec3 p, uint seed) {
  vec3 i = floor(p); vec3 f = p - i; ivec3 c = ivec3(i);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = latticeHash(c, seed);
  float n100 = latticeHash(c + ivec3(1,0,0), seed);
  float n010 = latticeHash(c + ivec3(0,1,0), seed);
  float n110 = latticeHash(c + ivec3(1,1,0), seed);
  float n001 = latticeHash(c + ivec3(0,0,1), seed);
  float n101 = latticeHash(c + ivec3(1,0,1), seed);
  float n011 = latticeHash(c + ivec3(0,1,1), seed);
  float n111 = latticeHash(c + ivec3(1,1,1), seed);
  float x00 = mix(n000, n100, u.x), x10 = mix(n010, n110, u.x);
  float x01 = mix(n001, n101, u.x), x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}
float fbm(vec3 p, uint seed, int oct) {
  float sum = 0.0, amp = 0.5, freq = 1.0, norm = 0.0;
  for (int o = 0; o < 8; o++) {
    if (o >= oct) break;
    sum += amp * vnoise(p * freq, seed + uint(o) * 1013u);
    norm += amp; amp *= 0.5; freq *= 2.03;
  }
  return sum / norm;
}
float terrainHeight(vec3 n, uint seed) {
  float wx = fbm(n * 1.1 + vec3(5.2, 1.3, 7.7), seed ^ 0x51u, 3);
  float wy = fbm(n * 1.1 + vec3(2.8, 9.1, 3.4), seed ^ 0x52u, 3);
  float base = fbm(vec3(n.x * 1.7 + (wx - 0.5) * 1.2, n.y * 1.7 + (wy - 0.5) * 1.2, n.z * 1.7), seed, 6);
  return clamp((base - 0.5) * 1.6 + 0.5, 0.0, 1.0);
}
uint seedFrom(float lo, float hi) { return uint(lo) | (uint(hi) << 16u); }
`;

export const BLACKBODY_GLSL = /* glsl */ `
vec3 blackbody(float T) {
  T = clamp(T, 1000.0, 40000.0) / 100.0;
  vec3 c;
  if (T <= 66.0) {
    c.r = 1.0;
    c.g = clamp((99.4708025861 * log(T) - 161.1195681661) / 255.0, 0.0, 1.0);
    c.b = T <= 19.0 ? 0.0 : clamp((138.5177312231 * log(T - 10.0) - 305.0447927307) / 255.0, 0.0, 1.0);
  } else {
    c.r = clamp(329.698727446 * pow(T - 60.0, -0.1332047592) / 255.0, 0.0, 1.0);
    c.g = clamp(288.1221695283 * pow(T - 60.0, -0.0755148492) / 255.0, 0.0, 1.0);
    c.b = 1.0;
  }
  return c;
}
`;

/** Galaxy transform texture: 4 texels per galaxy row (see CosmicLayer.updateGalaxyTexture). */
const GALAXY_TRANSFORM_GLSL = /* glsl */ `
uniform sampler2D uGal;
vec3 galaxyToWorld(vec3 local, int gi, out float formed) {
  vec4 t0 = texelFetch(uGal, ivec2(0, gi), 0);
  vec4 t1 = texelFetch(uGal, ivec2(1, gi), 0);
  vec4 t2 = texelFetch(uGal, ivec2(2, gi), 0);
  vec4 t3 = texelFetch(uGal, ivec2(3, gi), 0);
  float c = cos(t0.w), s = sin(t0.w);
  float rx = local.x * c - local.z * s;
  float rz = local.x * s + local.z * c;
  formed = t1.w;
  return t0.xyz + t1.xyz * rx + t2.xyz * local.y + t3.xyz * rz;
}
`;

// ---------------------------------------------------------------------------------------------
// Stars as points (all catalog stars of the universe in one draw call)

export const STAR_POINTS_VERT = /* glsl */ `
attribute vec3 aLocal;
attribute float aGal;
attribute vec4 aLife;   // birth, msEnd, death (Gyr), mass (M☉)
attribute vec2 aPhot;   // temperature (K), luminosity (L☉)
uniform float uTime;    // Gyr
uniform float uPixel;   // viewport height in px / (2 tan(fov/2))
uniform float uExposure;
uniform float uNearHide;
uniform float uHighlightGal;
uniform float uDpr;
${GALAXY_TRANSFORM_GLSL}
${BLACKBODY_GLSL}
varying vec3 vColor;
varying float vAlpha;
void main() {
  float formed;
  vec3 world = galaxyToWorld(aLocal, int(aGal + 0.5), formed);
  float birth = aLife.x, msEnd = aLife.y, death = aLife.z, mass = aLife.w;
  float L = aPhot.y; float T = aPhot.x;
  if (uTime < birth) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float age = uTime - birth;
  vec3 col;
  if (uTime < msEnd) {
    float f = clamp(age / max(1e-6, msEnd - birth), 0.0, 1.0);
    L *= 0.8 + 0.4 * f;
    col = blackbody(T);
    // Newborn stars flare briefly (protostellar phase)
    L *= 1.0 + 3.0 * exp(-age / 0.002);
  } else if (uTime < death) {
    float f = clamp((uTime - msEnd) / max(1e-6, death - msEnd), 0.0, 1.0);
    L = max(L * (10.0 + 300.0 * f * f), 50.0);
    col = blackbody(3600.0 - 600.0 * f);
  } else if (mass < 8.0) {
    L = 0.02 / (1.0 + (uTime - death) * 5.0); col = vec3(0.75, 0.82, 1.0);   // white dwarf
  } else {
    // supernova flash, then a faint remnant
    float since = uTime - death;
    L = 2e8 * exp(-since / 0.00003) + 1e-4; col = vec3(0.8, 0.9, 1.0);
  }
  vec4 mv = viewMatrix * vec4(world, 1.0);
  float d = max(1e-12, -mv.z);
  gl_Position = projectionMatrix * mv;
  // Apparent brightness ∝ L/d², auto-exposed to the camera's focal distance
  // (uExposure = k·focalDistance²): a star at the focal distance looks the same at every
  // zoom level, nearer stars brighter, farther dimmer — like a camera metering the subject.
  float b = L * uExposure / (d * d);
  float size = 1.0 + 1.1 * log(1.0 + b) / log(10.0);
  size = min(size, b > 1e4 ? 16.0 : 5.5);
  // A faint floor so the unresolved majority (M dwarfs) still integrates into disk light.
  float a = clamp(b * 0.5 + 0.06, 0.0, 1.0);
  a *= smoothstep(uNearHide, uNearHide * 3.0, d);
  a *= 0.35 + 0.65 * smoothstep(0.0, 0.3, formed);
  if (uHighlightGal >= 0.0 && abs(aGal - uHighlightGal) > 0.5) a *= 0.55;
  vColor = col;
  vAlpha = clamp(a, 0.0, 1.0);
  gl_PointSize = size * uDpr;
}
`;

export const STAR_POINTS_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 6.0);
  float halo = exp(-r2 * 1.6) * 0.35;
  gl_FragColor = vec4(vColor * (core + halo), (core + halo) * vAlpha);
}
`;

// ---------------------------------------------------------------------------------------------
// Primordial plasma → structure formation

export const PLASMA_VERT = /* glsl */ `
attribute vec3 aSeed;
attribute vec3 aOffset;
attribute float aGal;
attribute float aRand;
uniform float uScale;      // visual scale factor a(t)
uniform float uCluster;    // 0 → uniform, 1 → collapsed onto halos
uniform float uTempK;      // radiation temperature
uniform float uFade;
uniform float uPixel;
uniform vec3 uFocus;       // focus position (kpc, comoving × a already applied for galaxies)
${GALAXY_TRANSFORM_GLSL}
${BLACKBODY_GLSL}
varying vec3 vColor;
varying float vAlpha;
void main() {
  float formed;
  vec3 g = galaxyToWorld(vec3(0.0), int(aGal + 0.5), formed);   // galaxy centre relative to focus
  vec3 uniformPos = aSeed * uScale - uFocus;
  vec3 clustered = g + aOffset;
  float k = clamp(uCluster * (0.7 + 0.6 * aRand), 0.0, 1.0);
  vec3 world = mix(uniformPos, clustered, k);
  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(1e-9, -mv.z);
  float hot = smoothstep(2500.0, 6000.0, uTempK);
  vec3 col = uTempK > 3000.0 ? mix(blackbody(3000.0), vec3(1.0, 0.97, 0.9), hot) : mix(vec3(0.35, 0.12, 0.08), vec3(0.32, 0.45, 0.85), smoothstep(0.2, 1.0, uCluster));
  vColor = col;
  vAlpha = uFade * (0.08 + 0.6 * hot) * (0.6 + 0.4 * aRand) * (1.0 - 0.7 * uCluster);
  gl_PointSize = clamp(uPixel * (25.0 * uScale + 5.0) / d, 1.0, 40.0);
}
`;

export const PLASMA_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 3.0) * vAlpha;
  gl_FragColor = vec4(vColor * a, a);
}
`;

// ---------------------------------------------------------------------------------------------
// Galaxy impostors (far LOD). Oriented quads in the galaxy plane; ellipticals billboard.

export const IMPOSTOR_VERT = /* glsl */ `
attribute vec3 iCenter;
attribute vec3 iU;
attribute vec3 iV;
attribute vec4 iShape;   // type (0 spiral,1 ell,2 irr), arms, pitch, seed
attribute vec4 iState;   // angle, brightness, bulge, axis ratio
varying vec2 vUv;
varying vec4 vShape;
varying vec4 vState;
void main() {
  vUv = position.xy * 1.3;
  vShape = iShape; vState = iState;
  vec3 world;
  if (iShape.x > 0.5 && iShape.x < 1.5) {
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    float r = length(iU);
    world = iCenter + (right * position.x * 1.3 + up * position.y * 1.3 * iState.w) * r;
  } else {
    world = iCenter + iU * position.x * 1.3 + iV * position.y * 1.3;
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const IMPOSTOR_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec4 vShape;
varying vec4 vState;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
void main() {
  float r = length(vUv);
  if (r > 1.3) discard;
  float type = vShape.x;
  float bright = vState.y;
  vec3 col; float dens;
  if (type < 0.5) {
    float theta = atan(vUv.y, vUv.x) - vState.x;
    float arms = vShape.y; float pitch = vShape.z;
    float r0 = 0.08;
    float spiral = log(max(r, r0) / r0) / tan(pitch);
    float armD = 0.0;
    for (int k = 0; k < 4; k++) {
      if (float(k) >= arms) break;
      float d = mod(theta - spiral - 6.2831853 * float(k) / arms + 3.14159265, 6.2831853) - 3.14159265;
      armD += exp(-d * d / 0.18);
    }
    float disk = exp(-r / 0.29);
    float bulge = exp(-r * r / 0.012) * (0.6 + 2.0 * vState.z);
    float dust = 1.0 - 0.35 * smoothstep(0.2, 1.0, armD) * smoothstep(0.1, 0.3, r) * n2(vUv * 18.0 + vShape.w);
    dens = (disk * (0.35 + 1.1 * armD) * dust + bulge);
    col = mix(vec3(0.62, 0.72, 1.0), vec3(1.0, 0.86, 0.62), clamp(bulge * 1.4 + 0.15, 0.0, 1.0));
    col = mix(col, vec3(1.0, 0.55, 0.7), 0.25 * smoothstep(0.6, 1.4, armD) * n2(vUv * 30.0 + vShape.w));
  } else if (type < 1.5) {
    dens = exp(-pow(r / 0.33, 0.6) * 2.2) * 1.4;
    col = vec3(1.0, 0.85, 0.66);
  } else {
    float n = n2(vUv * 3.0 + vShape.w) * 0.7 + n2(vUv * 9.0 + vShape.w * 1.7) * 0.3;
    dens = exp(-r * r / 0.25) * smoothstep(0.35, 0.8, n) * 1.4;
    col = mix(vec3(0.6, 0.75, 1.0), vec3(1.0, 0.7, 0.85), n2(vUv * 6.0 + 3.0));
  }
  float a = clamp(dens * bright, 0.0, 1.5);
  gl_FragColor = vec4(col * a, a);
}
`;

// ---------------------------------------------------------------------------------------------
// Planet surface

export const PLANET_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vObj;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main() {
  vObj = position;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

export const PLANET_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uSeedLo, uSeedHi;
uniform int uKind;          // 0 rocky, 1 gas giant, 2 ice giant
uniform float uSea;         // sea level in height units (−1 = no ocean, 2 = global ocean)
uniform float uIceLat;      // radians
uniform float uSeason;      // sub-solar latitude (radians)
uniform vec3 uDeep, uShallow, uLow, uHigh, uPeak;
uniform float uVegetation;  // 0..1
uniform float uLava;        // 0..1
uniform float uCityLights;  // 0..1
uniform vec4 uCities[32];   // xyz dir (object space), w size
uniform int uCityCount;
uniform vec3 uSunDir;       // world
uniform vec3 uBand1, uBand2, uBand3;
uniform float uFlow;
uniform float uStorm;
uniform vec3 uAtmo;
uniform float uAtmoStrength;
uniform float uDetail;
${NOISE_GLSL}
varying vec3 vObj;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main() {
  #include <logdepthbuf_fragment>
  uint seed = seedFrom(uSeedLo, uSeedHi);
  vec3 n = normalize(vObj);
  vec3 N = normalize(vWorldNormal);
  float lambert = dot(N, uSunDir);
  float day = smoothstep(-0.08, 0.12, lambert);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 albedo; vec3 emissive = vec3(0.0); float spec = 0.0;
  float lat = asin(clamp(n.y, -1.0, 1.0));
  if (uKind == 0) {
    float h = terrainHeight(n, seed);
    if (uDetail > 0.0) h += (fbm(n * 22.0, seed ^ 0x99u, 4) - 0.5) * 0.05 * uDetail;
    // Seasonal ice: the winter hemisphere's cap grows, the summer cap shrinks.
    float iceLat = uIceLat - 0.35 * uSeason * sign(lat) * step(0.01, abs(uSeason));
    float ice = smoothstep(iceLat - 0.04, iceLat + 0.04, abs(lat) + (fbm(n * 6.0, seed ^ 0x3u, 3) - 0.5) * 0.18);
    if (h < uSea) {
      float depth = clamp((uSea - h) / 0.18, 0.0, 1.0);
      albedo = mix(uShallow, uDeep, depth);
      spec = 1.0;
    } else {
      float e = clamp((h - uSea) / max(0.05, 1.0 - uSea), 0.0, 1.0);
      albedo = e < 0.45 ? mix(uLow, uHigh, e / 0.45) : mix(uHigh, uPeak, (e - 0.45) / 0.55);
      float moist = fbm(n * 4.0 + 3.1, seed ^ 0x7u, 4);
      float temperate = 1.0 - smoothstep(0.6, 1.25, abs(lat));
      float veg = uVegetation * smoothstep(0.35, 0.62, moist) * temperate * (1.0 - smoothstep(0.35, 0.7, e));
      albedo = mix(albedo, mix(vec3(0.09, 0.22, 0.07), vec3(0.2, 0.32, 0.1), moist), veg);
      if (uLava > 0.0) {
        float cracks = pow(1.0 - abs(fbm(n * 9.0, seed ^ 0x1au, 4) * 2.0 - 1.0), 12.0);
        emissive += vec3(1.0, 0.32, 0.05) * cracks * uLava * 2.2;
      }
    }
    albedo = mix(albedo, vec3(0.93, 0.95, 1.0), ice);
    spec *= (1.0 - ice);
    // City lights on the night side.
    if (uCityLights > 0.0) {
      float lights = 0.0;
      for (int i = 0; i < 32; i++) {
        if (i >= uCityCount) break;
        vec4 c = uCities[i];
        float d = acos(clamp(dot(n, c.xyz), -1.0, 1.0));
        // Dense core fading into sprawl, broken into street-grid sparkle.
        float f = 1.0 - smoothstep(0.0, c.w, d);
        lights += f * f * step(0.45, vnoise(n * 900.0, seed)) * (0.6 + 0.4 * vnoise(n * 300.0, seed ^ 0x2u));
      }
      lights *= step(uSea, terrainHeight(n, seed));
      emissive += vec3(1.0, 0.72, 0.38) * min(lights, 1.0) * uCityLights * (1.0 - day) * 0.9;
    }
  } else {
    float turb = fbm(vec3(n.x * 2.5 + uFlow, n.y * 9.0, n.z * 2.5), seed, 5);
    float y = n.y + (turb - 0.5) * 0.16;
    float b = sin(y * (uKind == 1 ? 26.0 : 12.0) + turb * 3.0) * 0.5 + 0.5;
    float b2 = sin(y * 7.0 + 1.3) * 0.5 + 0.5;
    albedo = mix(mix(uBand1, uBand2, b), uBand3, b2 * 0.35);
    // A long-lived anticyclonic storm.
    vec3 sc = normalize(vec3(cos(uFlow * 0.3), -0.35, sin(uFlow * 0.3)));
    float storm = smoothstep(0.16, 0.0, distance(n * vec3(1.0, 1.6, 1.0), sc * vec3(1.0, 1.6, 1.0))) * uStorm;
    albedo = mix(albedo, vec3(0.75, 0.38, 0.25), storm);
  }
  vec3 H = normalize(uSunDir + V);
  float specular = spec * pow(max(dot(N, H), 0.0), 60.0) * 0.6 * day;
  vec3 lit = albedo * (max(lambert, 0.0) * 1.1 + 0.015) + specular;
  // Rim scattering from the atmosphere.
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  lit += uAtmo * rim * uAtmoStrength * smoothstep(-0.3, 0.4, lambert);
  gl_FragColor = vec4(lit + emissive, 1.0);
}
`;

export const ATMO_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uAtmo;
uniform float uStrength;
uniform vec3 uSunDir;
varying vec3 vObj;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float f = pow(clamp(1.0 + dot(N, V) * 1.15, 0.0, 1.0), 2.2);
  float sun = smoothstep(-0.35, 0.5, dot(N, uSunDir));
  float a = f * uStrength * sun;
  gl_FragColor = vec4(uAtmo * a, a);
}
`;

export const CLOUD_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uSeedLo, uSeedHi;
uniform float uCover;
uniform float uDrift;
uniform vec3 uSunDir;
uniform vec3 uTint;
${NOISE_GLSL}
varying vec3 vObj;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main() {
  #include <logdepthbuf_fragment>
  uint seed = seedFrom(uSeedLo, uSeedHi) ^ 0x77u;
  vec3 n = normalize(vObj);
  float lat = asin(n.y);
  vec3 p = vec3(n.x * cos(uDrift) - n.z * sin(uDrift), n.y, n.x * sin(uDrift) + n.z * cos(uDrift));
  float c = fbm(p * 3.2 + vec3(0.0, lat * 2.0, 0.0), seed, 5);
  float a = smoothstep(1.0 - uCover, 1.0 - uCover + 0.22, c);
  float light = smoothstep(-0.1, 0.25, dot(normalize(vWorldNormal), uSunDir));
  gl_FragColor = vec4(uTint * (0.08 + 0.92 * light), a * 0.92);
}
`;

// ---------------------------------------------------------------------------------------------
// Star surface + corona

export const STAR_SURFACE_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uTime;
uniform float uSeedLo, uSeedHi;
${NOISE_GLSL}
varying vec3 vObj;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main() {
  #include <logdepthbuf_fragment>
  uint seed = seedFrom(uSeedLo, uSeedHi);
  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float mu = max(dot(N, V), 0.0);
  float limb = 0.4 + 0.6 * pow(mu, 0.55);
  vec3 n = normalize(vObj);
  float gran = fbm(n * 18.0 + vec3(uTime, 0.0, -uTime), seed, 4);
  float spots = smoothstep(0.72, 0.8, fbm(n * 3.0 + vec3(0.0, uTime * 0.1, 0.0), seed ^ 0x5u, 3));
  vec3 c = uColor * limb * (0.82 + 0.36 * gran) * (1.0 - 0.6 * spots);
  gl_FragColor = vec4(c * 1.6, 1.0);
}
`;

export const CORONA_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float s = length(vec3(modelMatrix[0][0], modelMatrix[0][1], modelMatrix[0][2]));
  mv.xy += position.xy * s;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

export const CORONA_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vUv);
  float ang = atan(vUv.y, vUv.x);
  float rays = 0.75 + 0.25 * sin(ang * 12.0) * sin(ang * 5.0 + 1.3);
  float g = exp(-r * 5.5) * 1.2 + exp(-r * 2.2) * 0.25 * rays;
  g *= smoothstep(1.0, 0.6, r);
  gl_FragColor = vec4(uColor * g * uIntensity, g * uIntensity);
}
`;

// ---------------------------------------------------------------------------------------------
// Asteroid belts: Keplerian orbits solved per vertex on the GPU.

export const BELT_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aOrbit;   // a (AU), e, i, node
attribute vec3 aAngles;  // argPeri, M at epoch, mean motion (rad/yr)
attribute float aSize;
uniform float uDt;       // years since epoch (rebased on the CPU to stay small)
uniform float uPixel;
varying float vAlpha;
void main() {
  float a = aOrbit.x, e = aOrbit.y, inc = aOrbit.z, node = aOrbit.w;
  float M = aAngles.y + aAngles.z * uDt;
  M = mod(M, 6.2831853);
  float E = e < 0.8 ? M : 3.14159265;
  for (int k = 0; k < 6; k++) E -= (E - e * sin(E) - M) / (1.0 - e * cos(E));
  float nu = 2.0 * atan(sqrt(1.0 + e) * sin(E * 0.5), sqrt(1.0 - e) * cos(E * 0.5));
  float r = a * (1.0 - e * cos(E));
  float u = nu + aAngles.x;
  float cO = cos(node), sO = sin(node), cI = cos(inc), sI = sin(inc), cU = cos(u), sU = sin(u);
  vec3 p = r * vec3(cO * cU - sO * sU * cI, sU * sI, -(sO * cU + cO * sU * cI));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(1e-9, -mv.z);
  gl_PointSize = clamp(uPixel * aSize * 0.0025 / d, 1.0, 3.0);
  vAlpha = clamp(uPixel * 0.006 / d, 0.15, 0.85);
  #include <logdepthbuf_vertex>
}
`;

export const BELT_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
varying float vAlpha;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  gl_FragColor = vec4(uColor, vAlpha);
}
`;

export const RING_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLocal;
varying vec3 vWorldPos;
void main() {
  vLocal = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

export const RING_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uInner, uOuter, uOpacity, uSeed;
uniform vec3 uColor;
uniform vec3 uSunDir;
uniform vec3 uPlanetPos;
uniform float uPlanetR;
varying vec3 vLocal;
varying vec3 vWorldPos;
float h11(float x) { return fract(sin(x * 91.17 + uSeed) * 43758.5453); }
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vLocal.xy);
  float t = (r - uInner) / (uOuter - uInner);
  if (t < 0.0 || t > 1.0) discard;
  float bands = 0.55 + 0.45 * sin(t * 90.0 + h11(floor(t * 40.0)) * 6.0) * h11(floor(t * 13.0));
  float gap = smoothstep(0.0, 0.02, abs(t - 0.62)) * smoothstep(0.0, 0.01, abs(t - 0.86));
  float a = uOpacity * bands * gap * smoothstep(0.0, 0.06, t) * smoothstep(1.0, 0.94, t);
  // Planet shadow on the rings.
  vec3 toP = uPlanetPos - vWorldPos;
  float along = dot(toP, uSunDir);
  float perp = length(toP - along * uSunDir);
  float shadow = (along < 0.0 && perp < uPlanetR) ? 0.15 : 1.0;
  gl_FragColor = vec4(uColor * shadow, a);
}
`;

// Simple screen-space glow sprite for markers (colonies, selection, civ territory).
export const MARKER_VERT = /* glsl */ `
attribute vec3 aLocal;
attribute float aGal;
attribute vec4 aColor;
uniform float uSize;
${GALAXY_TRANSFORM_GLSL}
varying vec4 vColor;
void main() {
  float formed;
  vec3 world = galaxyToWorld(aLocal, int(aGal + 0.5), formed);
  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  // aColor.a: 1 = capital (ring marker), < 1 = colony (small dot).
  gl_PointSize = aColor.a > 0.99 ? uSize : max(2.0, uSize * 0.28);
  vColor = aColor;
}
`;

export const MARKER_FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  if (r > 1.0) discard;
  float ring = smoothstep(0.55, 0.7, r) * smoothstep(1.0, 0.85, r);
  float core = exp(-r * r * 18.0);
  float a = vColor.a > 0.99 ? (ring * 0.9 + core * 0.8) : core * vColor.a;
  gl_FragColor = vec4(vColor.rgb * a, a);
}
`;

export const LINK_VERT = /* glsl */ `
attribute vec3 aLocal;
attribute float aGal;
attribute vec4 aColor;
${GALAXY_TRANSFORM_GLSL}
varying vec4 vColor;
void main() {
  float formed;
  vec3 world = galaxyToWorld(aLocal, int(aGal + 0.5), formed);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  vColor = aColor;
}
`;

export const LINK_FRAG = /* glsl */ `
varying vec4 vColor;
void main() { gl_FragColor = vec4(vColor.rgb * vColor.a, vColor.a); }
`;
