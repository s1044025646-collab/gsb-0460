/** Minimal complex number helpers. All phasors use RMS convention. */
export interface Cx {
  re: number;
  im: number;
}

export const cx = (re: number, im: number): Cx => ({ re, im });

export const add = (a: Cx, b: Cx): Cx => ({ re: a.re + b.re, im: a.im + b.im });

export const mul = (a: Cx, b: Cx): Cx => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});

export const scale = (a: Cx, k: number): Cx => ({ re: a.re * k, im: a.im * k });

export const div = (a: Cx, b: Cx): Cx => {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};

export const abs = (a: Cx): number => Math.hypot(a.re, a.im);

export const conj = (a: Cx): Cx => ({ re: a.re, im: -a.im });

/**
 * Phase angle in degrees on the half-open interval (-180, 180].
 * Returns null when the magnitude is zero (phase undefined).
 */
export const phaseDeg = (a: Cx): number | null => {
  if (a.re === 0 && a.im === 0) return null;
  let deg = (Math.atan2(a.im, a.re) * 180) / Math.PI;
  if (deg <= -180) deg += 360;
  return deg;
};
