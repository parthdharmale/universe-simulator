/**
 * Uniform spatial hash grid over a galaxy's star catalog (galaxy-local coordinates).
 *
 * Built lazily per galaxy, in O(n) with a counting sort: `cellStart[c]..cellStart[c+1]`
 * indexes into `items`, a flat Uint32Array of star indices. No per-cell arrays, no objects.
 * k-nearest-neighbour queries expand shells of cells outward until the k-th best distance
 * is guaranteed (shell radius × cell size ≥ current k-th distance).
 */
export class StarGrid {
  readonly cellSize: number;
  readonly dims: [number, number, number];
  readonly origin: [number, number, number];
  readonly cellStart: Uint32Array;
  readonly items: Uint32Array;

  constructor(
    readonly xs: ArrayLike<number>,
    readonly ys: ArrayLike<number>,
    readonly zs: ArrayLike<number>,
    targetPerCell = 8,
  ) {
    const n = xs.length;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      if (xs[i] < minX) minX = xs[i];
      if (ys[i] < minY) minY = ys[i];
      if (zs[i] < minZ) minZ = zs[i];
      if (xs[i] > maxX) maxX = xs[i];
      if (ys[i] > maxY) maxY = ys[i];
      if (zs[i] > maxZ) maxZ = zs[i];
    }
    if (n === 0) {
      minX = minY = minZ = 0;
      maxX = maxY = maxZ = 1;
    }
    const ex = Math.max(1e-6, maxX - minX), ey = Math.max(1e-6, maxY - minY), ez = Math.max(1e-6, maxZ - minZ);
    const volume = ex * ey * ez;
    const cells = Math.max(1, n / targetPerCell);
    this.cellSize = Math.max(Math.cbrt(volume / cells), Math.max(ex, ey, ez) / 128);
    this.origin = [minX, minY, minZ];
    this.dims = [
      Math.max(1, Math.ceil(ex / this.cellSize) + 1),
      Math.max(1, Math.ceil(ey / this.cellSize) + 1),
      Math.max(1, Math.ceil(ez / this.cellSize) + 1),
    ];
    const total = this.dims[0] * this.dims[1] * this.dims[2];
    const counts = new Uint32Array(total + 1);
    const cellOf = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const c = this.cellIndex(xs[i], ys[i], zs[i]);
      cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < total; c++) counts[c + 1] += counts[c];
    this.cellStart = counts.slice();
    const fill = counts.slice(0, total);
    this.items = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.items[fill[cellOf[i]]++] = i;
  }

  private coord(v: number, axis: 0 | 1 | 2) {
    const c = Math.floor((v - this.origin[axis]) / this.cellSize);
    return c < 0 ? 0 : c >= this.dims[axis] ? this.dims[axis] - 1 : c;
  }

  cellIndex(x: number, y: number, z: number): number {
    return (this.coord(z, 2) * this.dims[1] + this.coord(y, 1)) * this.dims[0] + this.coord(x, 0);
  }

  /**
   * k nearest stars to (x,y,z) satisfying `accept`. Returns indices sorted by distance
   * (ties broken by index, so results are deterministic). Uses squared distances and a
   * bounded insertion list (k is small), visiting shells of cells outward until no
   * unvisited cell can contain a closer star.
   */
  nearest(x: number, y: number, z: number, k: number, accept: (i: number) => boolean = () => true, maxRadius = Infinity): number[] {
    if (k <= 0) return [];
    const cx = this.coord(x, 0), cy = this.coord(y, 1), cz = this.coord(z, 2);
    const bi: number[] = [];
    const bd: number[] = [];
    const maxR2 = maxRadius * maxRadius;
    const maxShell = Math.max(this.dims[0], this.dims[1], this.dims[2]);
    const xs = this.xs, ys = this.ys, zs = this.zs;
    for (let r = 0; r <= maxShell; r++) {
      const z0 = Math.max(0, cz - r), z1 = Math.min(this.dims[2] - 1, cz + r);
      const y0 = Math.max(0, cy - r), y1 = Math.min(this.dims[1] - 1, cy + r);
      const x0 = Math.max(0, cx - r), x1 = Math.min(this.dims[0] - 1, cx + r);
      for (let z2 = z0; z2 <= z1; z2++) {
        const onZ = z2 === cz - r || z2 === cz + r;
        for (let y2 = y0; y2 <= y1; y2++) {
          const onY = onZ || y2 === cy - r || y2 === cy + r;
          for (let x2 = x0; x2 <= x1; x2++) {
            // Only the shell surface (the interior was visited at smaller r).
            if (!onY && x2 !== cx - r && x2 !== cx + r) continue;
            const c = (z2 * this.dims[1] + y2) * this.dims[0] + x2;
            for (let j = this.cellStart[c], je = this.cellStart[c + 1]; j < je; j++) {
              const i = this.items[j];
              const dx = xs[i] - x, dy = ys[i] - y, dz = zs[i] - z;
              const d = dx * dx + dy * dy + dz * dz;
              if (d > maxR2) continue;
              if (bi.length === k && (d > bd[k - 1] || (d === bd[k - 1] && i > bi[k - 1]))) continue;
              if (!accept(i)) continue;
              // Insert keeping (d, i) order.
              let pos = bi.length;
              while (pos > 0 && (bd[pos - 1] > d || (bd[pos - 1] === d && bi[pos - 1] > i))) pos--;
              bi.splice(pos, 0, i);
              bd.splice(pos, 0, d);
              if (bi.length > k) {
                bi.pop();
                bd.pop();
              }
            }
          }
        }
      }
      const reach = r * this.cellSize;
      if (bi.length === k && bd[k - 1] <= reach * reach) break;
      if (reach > maxRadius) break;
    }
    return bi;
  }

  /** All stars within radius. */
  within(x: number, y: number, z: number, radius: number): number[] {
    const out: number[] = [];
    const r = Math.ceil(radius / this.cellSize);
    const cx = this.coord(x, 0), cy = this.coord(y, 1), cz = this.coord(z, 2);
    for (let z2 = Math.max(0, cz - r); z2 <= Math.min(this.dims[2] - 1, cz + r); z2++)
      for (let y2 = Math.max(0, cy - r); y2 <= Math.min(this.dims[1] - 1, cy + r); y2++)
        for (let x2 = Math.max(0, cx - r); x2 <= Math.min(this.dims[0] - 1, cx + r); x2++) {
          const c = (z2 * this.dims[1] + y2) * this.dims[0] + x2;
          for (let j = this.cellStart[c]; j < this.cellStart[c + 1]; j++) {
            const i = this.items[j];
            if (Math.hypot(this.xs[i] - x, this.ys[i] - y, this.zs[i] - z) <= radius) out.push(i);
          }
        }
    return out.sort((a, b) => a - b);
  }
}
