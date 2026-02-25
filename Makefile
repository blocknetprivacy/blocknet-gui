.PHONY: all dev release clean

all: clean dev

dev:
	npm run dev

ui:
	mkdir -p ui && cp index.html main.js qr.js styles.css ui/ && cp -r icons ui/ && cp "src-tauri/icons/blocknet_bg_black.png" ui/icons/ && cp blocknet.png blocknet.svg ui/

release: ui
	bash scripts/update-core-binaries.sh
	CI=false npm run build
	bash scripts/customize-dmg.sh

clean:
	cd src-tauri && cargo clean
	rm -rf ~/Library/WebKit/blocknet-wallet
	rm -rf ~/Library/WebKit/com.blocknet.wallet
	rm -rf ~/Library/Caches/blocknet-wallet
	rm -rf ~/Library/Caches/com.blocknet.wallet

