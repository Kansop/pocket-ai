# Pocket AI

A private AI chat that runs **entirely on your device**. No server, no API key, no account. It uses [WebLLM](https://github.com/mlc-ai/web-llm) and WebGPU to run open models (Qwen, Llama, SmolLM) in the browser.

**Live:** https://kansop.github.io/pocket-ai/

## Features
- A ChatGPT-style chat with streaming replies, a Stop button, Retry, Edit and resend, and Copy. It can read replies aloud.
- **Models:** SmolLM2 360M (tiny), Qwen2.5 0.5B (the default, fast), Llama 3.2 1B (recommended for iPhone), Qwen2.5 1.5B and Llama 3.2 3B (about 2 GB, for Mac). Each one shows its size, memory needs and a warning. You can delete one model or clear them all.
- Models download once with a progress bar, then stay cached so the app works offline. There is a clear message when the browser doesn't support WebGPU.
- Chats are saved in IndexedDB. You can rename, delete and search them (titles and message text), and export them as JSON or Markdown or import them back.
- Replies render Markdown, with syntax-highlighted code blocks and copy buttons.
- **Personas:** 8 are built in and you can make your own. You can set a system prompt for one chat, add custom instructions, and change the temperature and reply length.
- **Web search:** off, auto-detect or always. It uses free Wikipedia and DuckDuckGo lookups, or Tavily if you add a key. Sources show as links, and chat keeps working offline without search.
- **Memory:** your name, an "About me" section, "remember that …" and "forget …" commands, and facts saved automatically. You can view, edit and delete everything it remembers.
- **Home page** with a greeting, clock, search bar, editable quick prompts, recent chats, model status, a storage and memory meter, memories and tips. You can turn widgets on or off, reorder them, and choose from 3 layouts.
- **Customizing:** the assistant's name and emoji avatar, accent color, wallpapers (presets or your own upload), light, dark or system theme, and chat width.
- **Storage and memory meter:** storage used and free, the size of each model, chats size, and RAM estimates. It warns you before a model that probably won't fit.
- It's an installable PWA (on iPhone: Share → Add to Home Screen) and works offline.

Everything (chats, memories, settings, models) stays on your device.
