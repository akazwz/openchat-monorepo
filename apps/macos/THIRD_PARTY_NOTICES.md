# Third-party notices

- Swift application template: [hello-swift](https://github.com/akazwz/hello-swift), MIT © 2026 akazwz. The original license is retained in `LICENSE`.
- Binary SDK packaging: [stasel/WebRTC](https://github.com/stasel/WebRTC), version 154.0.0, MIT. `Resources/WebRTC-Package-LICENSE.md` contains its license and is included in the application bundle.
- WebRTC implementation: [WebRTC](https://webrtc.googlesource.com/src/), BSD 3-clause. `Resources/WebRTC-LICENSE.txt` contains the upstream notice and is included in the application bundle. The SDK’s privacy manifest is retained in the embedded framework.

The binary SDK also contains upstream third-party components. Before publicly distributing a signed release, retain the notices for the exact SDK build and verify its dependency licenses; the local ad hoc build is not a prepared public distribution. Source revision and binary package resolution are pinned by `Heveta.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.
