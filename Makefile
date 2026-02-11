.PHONY: all dev release clean

APP_DATA = ~/Library/Application\ Support/com.blocknet.wallet

all: clean dev

dev:
	npm run dev

ui:
	mkdir -p ui && cp index.html main.js qr.js styles.css ui/ && cp -r icons ui/ && cp blocknet.png blocknet.svg ui/

release: ui
	npm run build

clean:
	cd src-tauri && cargo clean
	rm -rf $(APP_DATA)
	rm -rf ~/Library/WebKit/blocknet-wallet
	rm -rf ~/Library/WebKit/com.blocknet.wallet
	rm -rf ~/Library/Caches/blocknet-wallet
	rm -rf ~/Library/Caches/com.blocknet.wallet
