# LightFrame 🖼️

LightFrame is a blazingly fast, minimal, and highly responsive image viewer built with [Tauri v2](https://v2.tauri.app/), [React](https://reactjs.org/), and [Rust](https://www.rust-lang.org/). It is designed to replace bloated default OS viewers by offering instant startup times, smooth keyboard navigation, and zero-distraction viewing.

## Features

- **Blazing Fast**: Native filesystem access and Rust-powered folder scanning.
- **Ultra-Responsive Navigation**: Instant keyboard navigation with debounced background loading to mimic high-performance viewers like IrfanView.
- **Smart Folder Support**: Drag and drop an image or a whole folder. LightFrame instantly understands what you want.
- **Native Natural Sorting**: Images are loaded and sorted logically (e.g., `image2` comes before `image10`), with support for sorting by Date, Size, or Random.
- **Micro-Animations & Clean UI**: A disappearing Chrome interface, dark/light themes, and buttery smooth transitions.
- **Zoom & Pan**: Fluid mouse-drag panning and shortcut-driven zoom controls.

## Roadmap (Coming Soon)

- **Image Management**: Delete images safely or copy them to the clipboard.
- **Set as Default Viewer**: Allow users to easily register LightFrame as their default Windows Image Viewer.
- **EXIF Metadata Panel**: View camera settings, location, and date taken.
- **Quick OS Integrations**: "Open containing folder" integration.
- **Advanced Formats**: Native HEIC and AVIF support.
- **Enhanced Viewing**: Contact sheet (thumbnail strip) and multi-monitor support.
- **Image Manipulation**: Temporary and permanent rotation saving.

## Installation

You can download the latest pre-compiled installers for Windows, macOS, and Linux from the [Releases page](../../releases).

## Development

To run LightFrame locally, you'll need [Node.js](https://nodejs.org/), [pnpm](https://pnpm.io/), and [Rust](https://www.rust-lang.org/tools/install) installed.

```bash
# Clone the repo
git clone https://github.com/yourusername/lightframe.git
cd lightframe

# Install frontend dependencies
pnpm install

# Run the Tauri dev server
pnpm tauri dev
```

## Build for Production

To compile the application into a standalone binary/installer:

```bash
pnpm tauri build
```

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on our code of conduct, and the process for submitting pull requests to us.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
