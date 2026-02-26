.PHONY: all dev release flatpak clean

UNAME := $(shell uname)
ifeq ($(UNAME), Darwin)
  TAURI_BUILD_CONFIG := {"bundle":{"targets":["app"],"resources":["binaries/blocknet-aarch64-apple-darwin"]}}
else
  TAURI_BUILD_CONFIG := {"bundle":{"targets":["deb","rpm","appimage"],"resources":["binaries/blocknet-amd64-linux"]}}
endif

all: clean release

dev:
	npm run dev

ui:
	mkdir -p ui && cp index.html main.js qr.js styles.css ui/ && cp -r icons ui/ && cp "src-tauri/icons/blocknet_bg_black.png" ui/icons/ && cp blocknet.png blocknet.svg ui/

release: ui
	bash scripts/update-core-binaries.sh
	mkdir -p ~/.cache/tauri && cp scripts/linuxdeploy-plugin-gtk.sh ~/.cache/tauri/linuxdeploy-plugin-gtk.sh
	NO_STRIP=1 CI=false npx tauri build --config '$(TAURI_BUILD_CONFIG)'
	bash scripts/customize-dmg.sh
	bash scripts/build-flatpak.sh
	bash scripts/collect-builds.sh

flatpak:
	bash scripts/build-flatpak.sh

clean:
	cd src-tauri && cargo clean
	rm -rf flatpak/stage flatpak/build-dir flatpak/repo
	rm -rf builds/*
	touch builds/.gitkeep
	rm -rf ~/Library/WebKit/blocknet-wallet
	rm -rf ~/Library/WebKit/com.blocknet.wallet
	rm -rf ~/Library/Caches/blocknet-wallet
	rm -rf ~/Library/Caches/com.blocknet.wallet
