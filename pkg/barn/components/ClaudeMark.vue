<script>
// The claude burst, drawn rather than shipped.
//
// There is no logo asset in this repo and adding a binary one to a bundle that is already a
// megabyte and a half of JavaScript is a poor trade for a 16px glyph. So it is geometry: rays
// from a common centre, each a round-capped stroke, with the lengths varied because an evenly
// spaced starburst reads as a sparkle and this should read as the mark it is standing in for.
//
// `currentColor` is deliberately not the default. The mark is recognisable by its colour before
// it is recognisable by its shape at this size, so it carries the clay orange unless a caller
// asks otherwise - a toolbar of grey icons is exactly where one coloured one is the point.
const RAYS = [
  { angle: 0, length: 7.5, width: 1.9 },
  { angle: 34, length: 6.2, width: 1.6 },
  { angle: 66, length: 7.2, width: 1.8 },
  { angle: 97, length: 5.6, width: 1.5 },
  { angle: 128, length: 7.4, width: 1.9 },
  { angle: 162, length: 6.0, width: 1.6 },
  { angle: 196, length: 7.3, width: 1.8 },
  { angle: 228, length: 5.8, width: 1.5 },
  { angle: 262, length: 7.4, width: 1.9 },
  { angle: 296, length: 6.1, width: 1.6 },
  { angle: 330, length: 7.0, width: 1.8 },
];

// Where a ray starts. Not zero: the rays meet in a knot at the centre of the real mark rather
// than crossing, and a small inner radius is what gives that without eleven overlapping caps.
const INNER = 1.6;
const CENTRE = 12;

export default {
  name: 'ClaudeMark',

  props: {
    size: {
      type:    Number,
      default: 16,
    },

    // Pass 'currentColor' to have it inherit from whatever it is inside.
    color: {
      type:    String,
      default: '#d97757',
    },
  },

  computed: {
    rays() {
      return RAYS.map(({ angle, length, width }) => {
        const radians = angle * Math.PI / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);

        return {
          key: angle,
          x1:  (CENTRE + (cos * INNER)).toFixed(2),
          y1:  (CENTRE + (sin * INNER)).toFixed(2),
          x2:  (CENTRE + (cos * length)).toFixed(2),
          y2:  (CENTRE + (sin * length)).toFixed(2),
          width,
        };
      });
    },
  },
};
</script>

<template>
  <svg
    class="claude-mark"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <line
      v-for="ray in rays"
      :key="ray.key"
      :x1="ray.x1"
      :y1="ray.y1"
      :x2="ray.x2"
      :y2="ray.y2"
      :stroke="color"
      :stroke-width="ray.width"
      stroke-linecap="round"
    />
  </svg>
</template>

<style lang="scss" scoped>
.claude-mark {
  display: block;
  // The rays are drawn to the edge of the viewBox, so nothing here may clip them.
  overflow: visible;
}
</style>
