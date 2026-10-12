// Quaternion maths for the phone's orientation (shared by the phone app and the dashboard twin).
//
// Frames
//  - device: x = right edge, y = top edge, z = out of the screen (W3C DeviceOrientation)
//  - world : X = east, Y = north, Z = up
//  - CSS   : x = right, y = DOWN, z = toward the viewer
// The W3C angles (alpha, beta, gamma) are intrinsic Tait-Bryan angles Z-X'-Y''. A quaternion avoids the
// gimbal flips and wrap-around problems of interpolating those angles directly.

export type Quat = [number, number, number, number]; // w, x, y, z
type Vec3 = [number, number, number];

const DEG = Math.PI / 180;

/** Orientation quaternion (device -> world) from W3C deviceorientation angles in degrees. */
export function fromW3C(alpha: number, beta: number, gamma: number): Quat {
  const x = (beta || 0) * DEG;
  const y = (gamma || 0) * DEG;
  const z = (alpha || 0) * DEG;
  const cX = Math.cos(x / 2), cY = Math.cos(y / 2), cZ = Math.cos(z / 2);
  const sX = Math.sin(x / 2), sY = Math.sin(y / 2), sZ = Math.sin(z / 2);
  // q = qz(alpha) * qx(beta) * qy(gamma)  (W3C DeviceOrientation spec, worked example)
  return normalize([
    cX * cY * cZ - sX * sY * sZ,
    sX * cY * cZ - cX * sY * sZ,
    cX * sY * cZ + sX * cY * sZ,
    cX * cY * sZ + sX * sY * cZ,
  ]);
}

export function mul(a: Quat, b: Quat): Quat {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export function normalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Rotation of `rad` radians about a unit axis. */
export function axisAngle(axis: Vec3, rad: number): Quat {
  const s = Math.sin(rad / 2);
  return [Math.cos(rad / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}

/** Spherical linear interpolation along the shortest path. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let [bw, bx, by, bz] = b;
  let dot = a[0] * bw + a[1] * bx + a[2] * by + a[3] * bz;
  if (dot < 0) {
    // q and -q are the same rotation: take the short way round
    dot = -dot;
    bw = -bw; bx = -bx; by = -by; bz = -bz;
  }
  if (dot > 0.9995) {
    return normalize([a[0] + t * (bw - a[0]), a[1] + t * (bx - a[1]), a[2] + t * (by - a[2]), a[3] + t * (bz - a[3])]);
  }
  const theta = Math.acos(dot);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return [wa * a[0] + wb * bw, wa * a[1] + wb * bx, wa * a[2] + wb * by, wa * a[3] + wb * bz];
}

/** 3x3 rotation matrix (rows) mapping device coordinates to world coordinates. */
export function toMatrix(q: Quat): number[][] {
  const [w, x, y, z] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

const asinDeg = (v: number) => Math.asin(Math.max(-1, Math.min(1, v))) / DEG;

/**
 * Human-readable angles, identical on phone and dashboard:
 *  frontBack = how far the top edge points up (+) or down (-) from horizontal
 *  leftRight = how far the right edge points down (+) or up (-) from horizontal
 *  heading   = direction the phone points (top + back), 0-360 clockwise from the reference
 */
export function readout(q: Quat): { frontBack: number; leftRight: number; heading: number } {
  const m = toMatrix(q);
  return { frontBack: asinDeg(m[2][1]), leftRight: -asinDeg(m[2][0]), heading: (headingRad(q) / DEG + 360) % 360 };
}

/**
 * Horizontal direction the phone points, projected on the ground: its top edge while the phone is
 * nearer flat, its back (-z) once the top edge points mostly up or down (held upright).
 */
export function headingRad(q: Quat): number {
  const m = toMatrix(q);
  if (Math.abs(m[2][1]) < 0.75) return Math.atan2(m[0][1], m[1][1]); // top edge
  return Math.atan2(-m[0][2], -m[1][2]); // back of the phone
}

/** Turn the world about the vertical axis so `yawRef` (radians) becomes "away from the viewer". */
export function recenter(q: Quat, yawRef: number): Quat {
  return mul(axisAngle([0, 0, 1], yawRef), q);
}

/**
 * CSS matrix3d for a phone element. The viewer looks north, level; the element's own
 * axes are CSS axes (y down), so T = W * R * C with W = world->CSS and C = CSS->device.
 */
export function cssMatrix3d(q: Quat): string {
  const m = toMatrix(q);
  const t = [
    [m[0][0], -m[0][1], m[0][2]],
    [-m[2][0], m[2][1], -m[2][2]],
    [-m[1][0], m[1][1], -m[1][2]],
  ];
  const f = (v: number) => (Math.abs(v) < 1e-6 ? 0 : +v.toFixed(5));
  return `matrix3d(${f(t[0][0])},${f(t[1][0])},${f(t[2][0])},0,${f(t[0][1])},${f(t[1][1])},${f(t[2][1])},0,${f(t[0][2])},${f(t[1][2])},${f(t[2][2])},0,0,0,0,1)`;
}

/** Compact wire format: [dtMs, w, x, y, z] with 4 decimals. */
export function pack(dt: number, q: Quat): number[] {
  return [Math.round(dt), +q[0].toFixed(4), +q[1].toFixed(4), +q[2].toFixed(4), +q[3].toFixed(4)];
}
