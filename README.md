# claudescreenfix-hardwicksoftware | [justcalljon.pro](https://justcalljon.pro/)

yo this fixes the scroll glitch that's been cooking everyone using claude code. you know the one - after like 30 minutes your terminal starts lagging, scrolling takes forever, and eventually the whole thing just dies.

## shoutout to the big dogs who should probably just fix this themselves

hey [@anthropics](https://github.com/anthropics) yall made a sick product but this scrollback thing been cooking people for months lol. maybe steal this fix idc

- [@karpathy](https://github.com/karpathy) - andrej you literally built tesla autopilot you could prob fix this in 5 min
- [@gdb](https://github.com/gdb) - greg brockman openai president, yall next with codex btw dont make the same mistake
- [@yoheinakajima](https://github.com/yoheinakajima) - babyagi goat, agent builders been struggling with this
- [@lllyasviel](https://github.com/lllyasviel) - controlnet legend, sd-forge too, you know terminal pain
- [@sama](https://github.com/sama) - sam you should try claude code sometime since chatgpt cant even write a working script without refusing half the prompts. also sora slapping watermarks on everything is straight clown behavior, nobody asked for that. yall so worried about "safety" you forgot to make stuff that actually works. openai been mid lately fr

real talk tho [@anthropics](https://github.com/anthropics) just add `\x1b[3J` to your clear command and debounce SIGWINCH. thats literally it. im not even asking for credit just fix it for everyone 💀

## what's the problem

so here's the deal. claude code uses ink (it's like react but for terminals). every time something updates, ink re-renders everything. that's fine normally.

but here's where it gets ugly - it doesn't clear the scrollback buffer. ever. not once.

so after a while you've got thousands of lines sitting in your terminal's memory. every single re-render has to process all of em. resize your window? that triggers a re-render too. tmux users get hit especially hard cuz resize events fire like crazy with no chill.

the result: your terminal slows to a crawl. scrolling back takes 30+ seconds. your fans spin up. it's bad. real talk it's been annoying everyone.

## what this does

hooks into node's stdout at startup and does three things:

1. **clears scrollback periodically** - every 500 renders or 60 seconds, whichever comes first. your buffer won't grow forever anymore
2. **debounces resize events** - instead of firing 50 times a second, it waits 150ms for things to settle. tmux users you're welcome
3. **actually clears on /clear** - the /clear command only clears the screen, not scrollback. we fix that. it's kinda wild they didn't do this already

no patches to claude code itself. works with any version. just loads before claude starts and you're good.

## install

```bash
npm install -g claudescreenfix-hardwicksoftware
```

that's it. you don't need anything else.

## usage

### option 1: use the wrapper (easiest)

```bash
claude-fixed
```

instead of running `claude`, run `claude-fixed`. it finds your claude install and runs it with the fix loaded. couldn't be simpler.

### option 2: alias it

throw this in your `.bashrc` or `.zshrc`:

```bash
alias claude='claude-fixed'
```

now `claude` automatically uses the fix. you won't even notice it's there.

### option 3: manual loading

if you're the type who wants full control:

```bash
node --require claudescreenfix-hardwicksoftware/loader.cjs $(which claude)
```

or set NODE_OPTIONS if that's more your style:

```bash
export NODE_OPTIONS="--require $(npm root -g)/claudescreenfix-hardwicksoftware/loader.cjs"
claude
```

## config

here's what you can tweak via env vars:

| var | what it does | default |
|-----|--------------|---------|
| `CLAUDE_TERMINAL_FIX_DEBUG` | set to `1` for debug logs | off |
| `CLAUDE_TERMINAL_FIX_DISABLED` | set to `1` to disable entirely | off |

## api

if you wanna use it programmatically here's how:

```javascript
const fix = require('claudescreenfix-hardwicksoftware');

// install the fix (usually done automatically via loader)
fix.install();

// manually clear scrollback whenever you want
fix.clearScrollback();

// check what's going on
console.log(fix.getStats());

// tweak config at runtime
fix.setConfig('periodicClearMs', 30000);  // clear every 30s instead

// turn it off if you need to
fix.disable();
```

## how it works

the fix hooks `process.stdout.write` before claude loads. when ink writes to the terminal, we check if it's doing a screen clear (which happens on every re-render). after enough renders, we inject the ANSI escape sequence `\x1b[3J` which tells the terminal to dump its scrollback buffer.

for resize events, we intercept `process.on('SIGWINCH', ...)` and debounce the handlers. instead of firing immediately, we wait 150ms. if more resize events come in during that window, we reset the timer. only fires once things settle down.

bottom line: smooth terminal, no lag, no memory bloat. it just works.

## known issues

- some old terminals don't support `\x1b[3J` but that's pretty rare nowadays
- if you actually want to keep your scrollback history, this ain't for you
- debug mode writes to stderr which might look weird in some setups

## what this fixes

people have been complaining about:
- terminal lag after long sessions - fixed
- scrollback buffer growing unbounded - fixed
- resize causing massive lag in tmux/screen - fixed
- /clear not actually clearing everything - fixed

you shouldn't have to restart claude every 30 minutes anymore.

## license

MIT - do whatever you want with it
