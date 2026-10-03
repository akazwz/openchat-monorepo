# App icon

The application uses Heveta’s existing H mark from `packages/brand/src/index.tsx`. `Resources/BrandMark.svg` is the static macOS variant: the same geometry, a neutral dark tile, a light H, and transparent exterior padding. It replaces the starter template artwork.

Convert the vector master and export the catalog sizes:

```sh
mkdir -p .build
sips -s format png Resources/BrandMark.svg --out .build/icon-master.png
mise run icon --source .build/icon-master.png
```

The SVG declares 1024 × 1024 output. The `icon` task validates a square PNG with alpha, then generates 16, 32, 64, 128, 256, 512 and 1024 pixel assets using `sips`; `Contents.json` maps these to the standard macOS app icon slots. The task prepares every image before replacing the catalog and never runs during a normal build.

Inspect the master and small exports for transparent exterior edges and readability, then build Debug and Release. Exit an old Heveta instance before opening the new app. The source SVG and this workflow make the icon reproducible without image generation or additional rendering dependencies.
