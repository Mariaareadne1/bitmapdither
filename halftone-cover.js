/* =============================================================================
   halftone-cover.js
   Bayer ordered dithering over layered video, in real time.

   Three entry points:
     HalftoneCover.mount(el, config)   the live video cover
     HalftoneCover.image(img, opts)    dither a still image in place
     HalftoneCover.text(el, opts)      render a text element as pixels

   Serve over http:// or https://. Browsers refuse to read video pixels from a
   file:// page, so opening straight from disk shows an empty grid. Videos must
   be same-origin, or served with an Access-Control-Allow-Origin header.
   ========================================================================== */
(function (global) {
  "use strict";

  /* --- Maria's saved settings. Passing a config to mount() merges over these. */
  var DEFAULTS = {
    layers: [
      { src: "media/look.mp4", on: true, weight: 1, scale: 1, ox: 0, oy: 0,
        blend: "screen", matte: "off", appears: "always", switch: "cut",
        every: 6, hold: 1.6, fade: 0.5 },
      // "negate" instead of "dissolve": the second clip now flips the picture
      // to negative where it overlaps, rather than stacking into a dark ghost
      // matte "dark" keeps the negate flash inside the figure, so a plain
      // wall stays blank and the cover's edge never becomes visible
      { src: "media/hair.mp4", on: true, weight: 1, scale: 1.02, ox: 0, oy: 0,
        blend: "negate", matte: "dark", appears: "pulse", switch: "flicker",
        every: 6, hold: 2, fade: 0.25 },
      { src: null, on: false, weight: 0.02, scale: 1, ox: 0, oy: 0,
        blend: "multiply", matte: "light", appears: "pulse", switch: "flicker",
        every: 9, hold: 3, fade: 1 }
    ],
    matte:    { threshold: 0.5, softness: 0.28 },
    stills:   { on: false, srcs: [], opacity: 0.55, blend: "screen",
                rate: 0.3, size: 0.24 },
    tone:     { exposure: -0.09, contrast: 2.05, grain: 0.075, invert: false },
    dither:   { matrix: 2, dot: 1.5, threshold: -0.215, cellSample: true },
    knockout: { blankAbove: 0.75, solidBelow: 0.325 },
    motion:   { holdFps: 4, speed: 0.95, judder: 0, drift: 0, printWobble: 0 },
    pointer:  { mode: "disperse", radius: 0.38, strength: 0.75, settle: 0.9 },
    framing:  "cover",
    colors:   { ink: "#000000", paper: "#ffffff" },
    respectReducedMotion: true
  };

  /* negate   — where the incoming clip is dark, the picture underneath flips
                to its negative, so dark over dark reads light instead of
                stacking into a ghost. The flipped area keeps its own tones.
     solarize — only where BOTH clips are dark does it flip; elsewhere the
                lighter of the two wins, so highlights stay clean.          */
  var BLENDS = ["screen", "lighten", "multiply", "difference", "average",
                "dissolve", "negate", "solarize"];
  var MATTES = ["off", "light", "dark"];
  var PTR_MODES = ["off", "focus", "reveal", "repel", "disperse"];
  var TRAIL_N = 8;

  function idOf(list, name) { return Math.max(0, list.indexOf(name)); }

  function merge(base, over) {
    var out = {}, k;
    for (k in base) if (base.hasOwnProperty(k)) out[k] = base[k];
    for (k in over) {
      if (!over.hasOwnProperty(k)) continue;
      if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k]) &&
          base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
        out[k] = merge(base[k], over[k]);
      } else {
        out[k] = over[k];
      }
    }
    return out;
  }

  function hexToRgb(h) {
    var n = parseInt(String(h).replace("#", ""), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /* ==========================================================================
     Shaders
     ========================================================================== */
  var VERT =
    "attribute vec2 aPos; varying vec2 vUv;" +
    "void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }";

  var FRAG = [
    "precision highp float;",
    "varying vec2 vUv;",
    "uniform vec2 uRes;",
    "uniform sampler2D uTexA, uTexB, uTexC, uStill;",
    "uniform vec2 uArA, uArB, uArC;",
    "uniform vec4 uParA, uParB, uParC;",
    "uniform vec2 uOffA, uOffB, uOffC;",
    "uniform vec2 uMaskCtl;",
    "uniform vec4 uStillRect;",
    "uniform vec3 uStillPar;",
    "uniform float uExposure, uContrast, uInvert;",
    "uniform float uGrain, uSeed;",
    "uniform float uMatrix, uDot, uThresh, uCell, uFit;",
    "uniform vec3 uInk, uPaper;",
    "uniform vec2 uKnock;",
    "uniform vec3 uReg;",
    "uniform vec4 uPtr;",
    "uniform float uPtrMode;",
    "#define TRAIL 8",
    "uniform vec4 uTrail[TRAIL];",
    "uniform vec2 uDisperse;",

    "float lumOf(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }",
    "float bayer2(vec2 a){ a=floor(a); return fract(a.x*0.5 + a.y*a.y*0.75); }",
    "#define bayer4(a) (bayer2(0.5*(a))*0.25 + bayer2(a))",
    "#define bayer8(a) (bayer4(0.5*(a))*0.25 + bayer2(a))",
    "float hash(vec2 p, float s){",
    "  return fract(sin(dot(p, vec2(127.1,311.7)) + s*13.77) * 43758.5453);",
    "}",

    "vec2 coverUV(vec2 uv, float texAR, float scrAR, float scale, vec2 off){",
    "  vec2 k = vec2(1.0);",
    "  if (uFit < 0.5){",
    "    if (texAR > scrAR) k.x = scrAR/texAR; else k.y = texAR/scrAR;",
    "  } else {",
    "    if (texAR > scrAR) k.y = texAR/scrAR; else k.x = scrAR/texAR;",
    "  }",
    "  return (uv-0.5)*k/max(scale,0.05) + 0.5 + off + uReg.xy;",
    "}",

    "float sampleLayer(sampler2D t, vec2 uv, float texAR, float scrAR,",
    "                  float scale, vec2 off){",
    "  vec2 c = coverUV(uv, texAR, scrAR, scale, off);",
    "  if (c.x<0.0||c.x>1.0||c.y<0.0||c.y>1.0) return -1.0;",
    "  return lumOf(texture2D(t, c).rgb);",
    "}",

    "float blendPair(float base, float top, float mode, float w){",
    "  float r;",
    "  if      (mode<0.5) r = 1.0-(1.0-base)*(1.0-top);",
    "  else if (mode<1.5) r = max(base, top);",
    "  else if (mode<2.5) r = base*top;",
    "  else if (mode<3.5) r = abs(base-top);",
    "  else if (mode<4.5) r = (base+top)*0.5;",
    "  else if (mode<5.5) r = top;",
    "  else if (mode<6.5){ r = mix(base, 1.0-base, 1.0-top); }",
    "  else {",
    "    float ov = (1.0-base)*(1.0-top);",
    "    float m  = max(base, top);",
    "    r = mix(m, 1.0-m, ov);",
    "  }",
    "  return mix(base, r, w);",
    "}",

    "float matteFactor(float mode, float baseL){",
    "  if (mode<0.5) return 1.0;",
    "  float e = smoothstep(uMaskCtl.x-uMaskCtl.y, uMaskCtl.x+uMaskCtl.y, baseL);",
    "  if (mode<1.5) return e;",
    "  return 1.0-e;",
    "}",

    "void main(){",
    "  vec2 uv = vUv;",
    "  float scrAR = uRes.x/uRes.y;",

    "  float infl = 0.0; vec2 toP = vec2(0.0);",
    "  if (uPtrMode > 0.5){",
    "    toP = (uv - uPtr.xy) * vec2(scrAR,1.0);",
    "    infl = 1.0 - smoothstep(0.0, max(uPtr.z,0.001), length(toP));",
    "  }",
    "  if (uPtrMode > 2.5 && uPtrMode < 3.5 && infl > 0.0){",
    "    uv += normalize(toP+vec2(1e-5))/vec2(scrAR,1.0) * infl * uPtr.w * 0.09;",
    "  }",
    "  if (uPtrMode > 3.5){",
    "    vec2 push = vec2(0.0); float tot = 0.0;",
    "    for (int i=0; i<TRAIL; i++){",
    "      float amp = uTrail[i].z;",
    "      if (amp > 0.002){",
    "        vec2 d = (uv - uTrail[i].xy) * vec2(scrAR,1.0);",
    "        float f = (1.0 - smoothstep(0.0, uDisperse.x, length(d))) * amp;",
    "        push += normalize(d+vec2(1e-5)) * f;",
    "        tot  += f;",
    "      }",
    "    }",
    "    if (tot > 0.001){",
    "      uv += push/vec2(scrAR,1.0) * uDisperse.y * 0.11;",
    "      vec2 cell = floor(gl_FragCoord.xy / max(uDot,1.0));",
    "      vec2 jit = vec2(hash(cell,7.3), hash(cell,19.1)) - 0.5;",
    "      uv += jit * min(tot,1.6) * uDisperse.y * 0.07;",
    "    }",
    "  }",

    "  float dotSize = uDot;",
    "  if (uPtrMode > 0.5 && uPtrMode < 1.5){",
    "    dotSize = mix(uDot, max(1.0, uDot*0.28), infl*uPtr.w);",
    "  }",

    "  vec2 uvq = uv;",
    "  if (uCell > 0.5){",
    "    vec2 px = uv*uRes;",
    "    px = (floor(px/dotSize)+0.5)*dotSize;",
    "    uvq = px/uRes;",
    "  }",

    "  float v = 0.0; float s; float baseL = 0.0; float got = 0.0;",
    "  if (uArA.y > 0.5){",
    "    s = sampleLayer(uTexA, uvq, uArA.x, scrAR, uParA.y, uOffA);",
    "    if (s >= 0.0){ baseL = s; v = mix(v, s, uParA.x); got = 1.0; }",
    "  }",
    "  if (uArB.y > 0.5){",
    "    s = sampleLayer(uTexB, uvq, uArB.x, scrAR, uParB.y, uOffB);",
    "    if (s >= 0.0){ v = blendPair(v, s, uParB.z, uParB.x*matteFactor(uParB.w, baseL));",
    "                   got = 1.0; }",
    "  }",
    "  if (uArC.y > 0.5){",
    "    s = sampleLayer(uTexC, uvq, uArC.x, scrAR, uParC.y, uOffC);",
    "    if (s >= 0.0){ v = blendPair(v, s, uParC.z, uParC.x*matteFactor(uParC.w, baseL));",
    "                   got = 1.0; }",
    "  }",

    "  if (uStillPar.x > 0.5){",
    "    vec2 r = (uvq - uStillRect.xy)/uStillRect.zw;",
    "    if (r.x>=0.0&&r.x<=1.0&&r.y>=0.0&&r.y<=1.0){",
    "      float sl = lumOf(texture2D(uStill, r).rgb);",
    "      vec2 fw = smoothstep(0.0,0.14,r)*smoothstep(0.0,0.14,1.0-r);",
    "      v = blendPair(v, sl, uStillPar.z, uStillPar.y*fw.x*fw.y);",
    "    }",
    "  }",

    "  v = (v-0.5)*uContrast + 0.5 + uExposure + uReg.z;",
    "  v = mix(v, 1.0-v, uInvert);",

    "  float thr = uThresh;",
    "  if (uPtrMode > 1.5 && uPtrMode < 2.5) thr += infl*uPtr.w*0.45;",

    "  vec3 col;",
    // Nothing covered this pixel — no clip loaded yet, or the frame does not
    // reach here. Fall through to bare paper, not ink: a missing video should
    // look like empty page, never a black slab.
    "  if (got < 0.5){ col = uPaper; }",
    "  else if (v >= uKnock.x){ col = uPaper; }",
    "  else if (v <= uKnock.y){ col = uInk; }",
    "  else {",
    "    if (uGrain > 0.001){",
    "      vec2 px = uv*uRes;",
    "      float fine = hash(floor(px), uSeed)-0.5;",
    "      float mott = hash(floor(px/9.0), uSeed*0.5)-0.5;",
    "      v += fine*uGrain + mott*uGrain*0.55;",
    "    }",
    "    v = clamp(v,0.0,1.0);",
    "    float b; vec2 g = gl_FragCoord.xy/max(dotSize,1.0);",
    "    if      (uMatrix<3.0) b = bayer2(g);",
    "    else if (uMatrix<6.0) b = bayer4(g);",
    "    else                  b = bayer8(g);",
    "    col = mix(uInk, uPaper, step(b, v+thr));",
    "  }",
    "  gl_FragColor = vec4(col,1.0);",
    "}"
  ].join("\n");

  /* ==========================================================================
     mount() — the live cover
     ========================================================================== */
  function mount(host, userConfig) {
    if (typeof host === "string") host = document.querySelector(host);
    if (!host) throw new Error("HalftoneCover.mount: container not found");

    var CFG = merge(DEFAULTS, userConfig || {});

    /* `sources` is the safe way to point at your own clips: it swaps only the
       src paths and leaves every tuned value alone. Passing a whole `layers`
       array replaces the array wholesale, which silently takes the blend
       modes, mattes and pulse timing with it. */
    if (userConfig && userConfig.sources) {
      CFG.layers = CFG.layers.map(function (L, i) {
        var src = userConfig.sources[i];
        if (src === undefined) return L;
        var copy = merge(L, {});
        copy.src = src;
        copy.on = !!src;
        return copy;
      });
    }

    var canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:100%;height:100%";
    host.appendChild(canvas);

    var gl = canvas.getContext("webgl", { antialias: false });
    if (!gl) { host.style.background = CFG.colors.ink; return null; }

    function compile(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error("HalftoneCover:", gl.getShaderInfoLog(sh));
      }
      return sh;
    }

    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    var U = {};
    ["uRes","uTexA","uTexB","uTexC","uStill","uArA","uArB","uArC","uParA","uParB",
     "uParC","uOffA","uOffB","uOffC","uMaskCtl","uStillRect","uStillPar","uExposure",
     "uContrast","uInvert","uGrain","uSeed","uMatrix","uDot","uThresh","uCell","uFit",
     "uInk","uPaper","uKnock","uReg","uPtr","uPtrMode","uDisperse"]
      .forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
    U.uTrail = gl.getUniformLocation(prog, "uTrail[0]");

    // Video frames arrive origin-top-left; GL textures start bottom-left.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    function makeTex(unit) {
      var t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA,
                    gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,255]));
      return t;
    }
    var TEX = [makeTex(0), makeTex(1), makeTex(2)];
    var STILL_TEX = makeTex(3);
    gl.uniform1i(U.uTexA,0); gl.uniform1i(U.uTexB,1);
    gl.uniform1i(U.uTexC,2); gl.uniform1i(U.uStill,3);

    var reduced = CFG.respectReducedMotion &&
      global.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Browsers only decode reliably for elements in the document. Never
    // display:none — that stops decoding.
    var vault = document.createElement("div");
    vault.setAttribute("aria-hidden", "true");
    vault.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;" +
      "overflow:hidden;opacity:0;pointer-events:none;z-index:-1";
    document.body.appendChild(vault);

    var warned = false;
    function warnOnce(src) {
      if (warned) return;
      warned = true;
      console.warn("HalftoneCover: can't read pixels from " + (src || "the video") +
        ". " + (location.protocol === "file:"
          ? "Serve the page over http:// — e.g. `python3 -m http.server`."
          : "Host the video on this origin, or send Access-Control-Allow-Origin."));
    }

    var videos = CFG.layers.map(function (L) {
      if (!L.src || !L.on) return null;
      var v = document.createElement("video");
      v.muted = true; v.loop = true; v.playsInline = true; v.preload = "auto";
      v.setAttribute("muted",""); v.setAttribute("playsinline","");
      v.src = L.src;
      v.playbackRate = Math.max(0.1, CFG.motion.speed || 1);
      vault.appendChild(v);
      v.play().catch(function(){});
      return v;
    });

    function resume() { videos.forEach(function (v) { if (v && !reduced) v.play().catch(function(){}); }); }
    ["click","touchstart","keydown"].forEach(function (ev) {
      document.addEventListener(ev, resume, { once: true });
    });

    var stills = [];
    (CFG.stills.srcs || []).forEach(function (src) {
      var im = new Image();
      im.onload = function () { stills.push(im); };
      im.src = src;
    });

    /* --- pointer ------------------------------------------------------- */
    var ptrMode = idOf(PTR_MODES, CFG.pointer.mode);
    var ptr = { x: 0.5, y: 0.5 };
    var trail = [], trailBuf = new Float32Array(TRAIL_N * 4);
    var trailHead = 0, lastSample = 0;
    for (var ti = 0; ti < TRAIL_N; ti++) trail.push({ x: 0.5, y: 0.5, t: -1e9 });

    if (ptrMode > 0) {
      host.addEventListener("pointermove", function (e) {
        var r = host.getBoundingClientRect();
        ptr.x = (e.clientX - r.left) / Math.max(1, r.width);
        ptr.y = 1 - (e.clientY - r.top) / Math.max(1, r.height);
        var t = performance.now();
        if (t - lastSample > 40) {
          lastSample = t;
          trailHead = (trailHead + 1) % TRAIL_N;
          trail[trailHead] = { x: ptr.x, y: ptr.y, t: t };
        }
      });
      host.addEventListener("pointerleave", function () { ptr.x = 0.5; ptr.y = 0.5; });
    }

    function packTrail(now) {
      var tau = Math.max(60, (CFG.pointer.settle || 0.9) * 1000);
      for (var i = 0; i < TRAIL_N; i++) {
        var s = trail[i], amp = Math.exp(-(now - s.t) / tau);
        trailBuf[i*4] = s.x; trailBuf[i*4+1] = s.y;
        trailBuf[i*4+2] = amp > 0.002 ? amp : 0; trailBuf[i*4+3] = 0;
      }
      return trailBuf;
    }

    /* --- transitions, latched once per held frame ----------------------- */
    function ramp(local, fade, hold) {
      if (local < 0) return 0;
      if (local < fade) return local / Math.max(0.001, fade);
      if (local < fade + hold) return 1;
      if (local < fade*2 + hold) return 1 - (local - fade - hold)/Math.max(0.001, fade);
      return 0;
    }
    function computeEnv(L, nowMs) {
      if (reduced || L.appears !== "pulse") return 1;
      var fade = L.fade || 0, hold = L.hold || 1;
      var period = Math.max(hold + fade*2 + 0.2, L.every || 6);
      var r = ramp((nowMs/1000) % period, fade, hold);
      if (L.switch === "fade") return r;
      if (L.switch === "cut") return r >= 0.5 ? 1 : 0;
      return Math.random() < r ? 1 : 0;
    }
    var envs = CFG.layers.map(function () { return 1; });

    /* --- loop ----------------------------------------------------------- */
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var M = CFG.motion, reg = { x:0, y:0, z:0 };
    var nextTick = 0, idx = 0, raf = 0, dead = false;
    var pick = { on:0, x:0, y:0, w:0.2, h:0.25 };

    function resize() {
      var r = host.getBoundingClientRect();
      var w = Math.max(2, Math.floor(r.width * dpr));
      var h = Math.max(2, Math.floor(r.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    }
    var ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    function frame(now) {
      if (dead) return;
      var fresh = !reduced && now >= nextTick;
      if (fresh) {
        var base = 1000 / Math.max(1, M.holdFps);
        nextTick = now + base * (1 + (Math.random()-0.5)*2*(M.judder||0)*0.6);
        idx++;
        reg.x = (Math.random()-0.5)*(M.drift||0)*0.035;
        reg.y = (Math.random()-0.5)*(M.drift||0)*0.035;
        reg.z = (Math.random()-0.5)*(M.printWobble||0)*0.22;
        CFG.layers.forEach(function (L, i) { envs[i] = computeEnv(L, now); });

        videos.forEach(function (v, i) {
          if (v && v.readyState >= 2) {
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(gl.TEXTURE_2D, TEX[i]);
            try { gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,v); }
            catch (e) { warnOnce(v.currentSrc); }
          }
        });

        if (CFG.stills.on && stills.length && Math.random() < CFG.stills.rate) {
          var im = stills[Math.floor(Math.random()*stills.length)];
          var ar = im.naturalWidth / Math.max(1, im.naturalHeight);
          var hh = CFG.stills.size;
          var ww = hh * ar * (canvas.height / Math.max(1, canvas.width));
          pick = { on:1, x:Math.random()*(1-ww), y:Math.random()*(1-hh), w:ww, h:hh };
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, STILL_TEX);
          try { gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,im); }
          catch (e) {}
        } else { pick.on = 0; }
      }

      gl.uniform2f(U.uRes, canvas.width, canvas.height);
      [["uArA","uParA","uOffA",0],["uArB","uParB","uOffB",1],["uArC","uParC","uOffC",2]]
        .forEach(function (t) {
          var L = CFG.layers[t[3]], v = videos[t[3]];
          var live = !!(v && v.readyState >= 2) && L.on;
          gl.uniform2f(U[t[0]], live ? v.videoWidth/v.videoHeight : 1, live ? 1 : 0);
          gl.uniform4f(U[t[1]], L.weight*envs[t[3]], L.scale,
                       idOf(BLENDS, L.blend), idOf(MATTES, L.matte));
          gl.uniform2f(U[t[2]], L.ox, L.oy);
        });
      gl.uniform2f(U.uMaskCtl, CFG.matte.threshold, Math.max(0.005, CFG.matte.softness));
      gl.uniform4f(U.uStillRect, pick.x, pick.y, pick.w, pick.h);
      gl.uniform3f(U.uStillPar, pick.on, CFG.stills.opacity, idOf(BLENDS, CFG.stills.blend));
      gl.uniform1f(U.uExposure, CFG.tone.exposure);
      gl.uniform1f(U.uContrast, CFG.tone.contrast);
      gl.uniform1f(U.uInvert, CFG.tone.invert ? 1 : 0);
      gl.uniform1f(U.uGrain, CFG.tone.grain);
      gl.uniform1f(U.uSeed, idx % 997);
      gl.uniform1f(U.uMatrix, CFG.dither.matrix);
      gl.uniform1f(U.uDot, CFG.dither.dot * dpr);
      gl.uniform1f(U.uThresh, CFG.dither.threshold);
      gl.uniform1f(U.uCell, CFG.dither.cellSample ? 1 : 0);
      gl.uniform1f(U.uFit, CFG.framing === "contain" ? 1 : 0);
      gl.uniform3fv(U.uInk, hexToRgb(CFG.colors.ink));
      gl.uniform3fv(U.uPaper, hexToRgb(CFG.colors.paper));
      gl.uniform2f(U.uKnock, CFG.knockout.blankAbove, CFG.knockout.solidBelow);
      gl.uniform3f(U.uReg, reg.x, reg.y, reg.z);
      gl.uniform4f(U.uPtr, ptr.x, ptr.y, CFG.pointer.radius, CFG.pointer.strength);
      gl.uniform1f(U.uPtrMode, ptrMode);
      gl.uniform2f(U.uDisperse, CFG.pointer.radius, CFG.pointer.strength);
      if (ptrMode === 4) gl.uniform4fv(U.uTrail, packTrail(now));

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return {
      config: CFG,
      destroy: function () {
        dead = true;
        cancelAnimationFrame(raf);
        ro.disconnect();
        vault.remove();
        canvas.remove();
      }
    };
  }

  /* ==========================================================================
     Shared 4x4 Bayer threshold map, for the canvas-based helpers below
     ========================================================================== */
  var BAYER4 = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];

  function ditherPixels(data, w, h, opts) {
    var ink = opts.ink, paper = opts.paper, scale = Math.max(1, opts.dot | 0);
    var threshold = opts.threshold || 0, useAlpha = opts.useAlpha;
    var inkAt = opts.inkAt;                 // optional per-column ink
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        var signal = useAlpha
          ? data[i+3] / 255
          : (0.2126*data[i] + 0.7152*data[i+1] + 0.0722*data[i+2]) / 255 * (data[i+3]/255);
        var bx = Math.floor(x / scale) % 4, by = Math.floor(y / scale) % 4;
        var t = (BAYER4[by][bx] + 0.5) / 16;
        var on = signal + threshold >= t;
        if (useAlpha) {
          var k = inkAt ? inkAt(x) : ink;
          data[i] = k[0]; data[i+1] = k[1]; data[i+2] = k[2];
          data[i+3] = on ? 255 : 0;
        } else {
          var c = on ? paper : ink;
          data[i] = c[0]; data[i+1] = c[1]; data[i+2] = c[2]; data[i+3] = 255;
        }
      }
    }
  }

  function cssColorToRgb(c) {
    var m = String(c).match(/[\d.]+/g);
    if (!m) return [0,0,0];
    return [Math.round(+m[0]), Math.round(+m[1]), Math.round(+m[2])];
  }

  /* Split an element into runs of text that share a computed style, so a
     wordmark like MARIA + Showalter keeps its two weights and colours. */
  function styleRuns(el) {
    var runs = [];
    (function walk(node, styleSource) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var n = node.childNodes[i];
        if (n.nodeType === 3) {
          var t = n.nodeValue.replace(/\s+/g, " ");
          if (t.trim() === "" && runs.length === 0) continue;
          if (t) runs.push({ text: t, style: getComputedStyle(styleSource) });
        } else if (n.nodeType === 1) {
          walk(n, n);
        }
      }
    })(el, el);
    if (!runs.length) {
      runs.push({ text: (el.textContent || "").trim(), style: getComputedStyle(el) });
    }
    return runs;
  }

  function parseHex(h) {
    var n = parseInt(String(h).replace("#",""), 16);
    return [(n>>16)&255, (n>>8)&255, n&255];
  }

  /* ==========================================================================
     text() — render a text element as pixels, keeping it readable to
     screen readers and to search engines.
     ========================================================================== */
  function text(el, opts) {
    if (typeof el === "string") el = document.querySelector(el);
    if (!el) return;
    opts = opts || {};
    var dot = opts.dot || 2;
    var threshold = opts.threshold == null ? 0.02 : opts.threshold;
    var content = (opts.text || el.textContent || "").trim();
    if (!content) return;

    var runs = styleRuns(el);
    var SS = 2;                                  // supersample, then threshold
    var meas = document.createElement("canvas").getContext("2d");
    var maxPx = 0, wCss = 2;

    runs.forEach(function (r) {
      var px = parseFloat(r.style.fontSize) || 32;
      r.font = r.style.fontStyle + " " + r.style.fontWeight + " " + px + "px " +
               r.style.fontFamily;
      r.ls = parseFloat(r.style.letterSpacing) || 0;
      r.rgb = opts.ink ? parseHex(opts.ink) : cssColorToRgb(r.style.color);
      meas.font = r.font;
      r.w = meas.measureText(r.text).width + r.ls * r.text.length;
      r.x0 = wCss;
      wCss += r.w;
      if (px > maxPx) maxPx = px;
    });
    wCss = Math.ceil(wCss + 4);
    var hCss = Math.ceil(maxPx * 1.35);

    var c = document.createElement("canvas");
    c.width = wCss * SS; c.height = hCss * SS;
    var ctx = c.getContext("2d");
    ctx.scale(SS, SS);
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";                      // alpha is the signal, not colour

    runs.forEach(function (r) {
      ctx.font = r.font;
      var cx = r.x0;
      if (r.ls) {
        for (var i = 0; i < r.text.length; i++) {
          ctx.fillText(r.text[i], cx, hCss/2);
          cx += ctx.measureText(r.text[i]).width + r.ls;
        }
      } else {
        ctx.fillText(r.text, cx, hCss/2);
      }
    });

    var img = ctx.getImageData(0, 0, c.width, c.height);
    ditherPixels(img.data, c.width, c.height, {
      dot: dot * SS, threshold: threshold, useAlpha: true,
      ink: runs[0].rgb,
      inkAt: function (px) {                     // colour follows the run
        var x = px / SS;
        for (var i = runs.length - 1; i >= 0; i--) {
          if (x >= runs[i].x0) return runs[i].rgb;
        }
        return runs[0].rgb;
      }
    });
    ctx.putImageData(img, 0, 0);

    c.style.cssText = "width:" + wCss + "px;height:" + hCss + "px;" +
                      "display:block;image-rendering:pixelated";
    c.setAttribute("aria-hidden", "true");

    // keep the real words in the DOM, just not on screen
    var sr = document.createElement("span");
    sr.textContent = content;
    sr.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;" +
                       "clip:rect(0 0 0 0);white-space:nowrap";
    el.textContent = "";
    el.appendChild(sr);
    el.appendChild(c);
    return c;
  }

  /* ==========================================================================
     image() — dither a still image in place, for photos elsewhere on the page
     ========================================================================== */
  function image(img, opts) {
    if (typeof img === "string") img = document.querySelector(img);
    if (!img) return;
    opts = opts || {};
    var run = function () {
      var w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return;
      var maxW = opts.maxWidth || 900;
      if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      var ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      var d = ctx.getImageData(0, 0, w, h);
      var contrast = opts.contrast == null ? 1.2 : opts.contrast;
      for (var i = 0; i < d.data.length; i += 4) {
        for (var k = 0; k < 3; k++) {
          d.data[i+k] = Math.max(0, Math.min(255,
            (d.data[i+k]/255 - 0.5) * contrast * 255 + 127.5));
        }
      }
      ditherPixels(d.data, w, h, {
        ink: parseHex(opts.ink || "#000000"),
        paper: parseHex(opts.paper || "#ffffff"),
        dot: opts.dot || 2,
        threshold: opts.threshold || 0,
        useAlpha: false
      });
      ctx.putImageData(d, 0, 0);
      c.className = img.className;
      c.style.cssText = getComputedStyle(img).cssText;
      c.style.imageRendering = "pixelated";
      if (img.alt) c.setAttribute("role", "img"), c.setAttribute("aria-label", img.alt);
      img.replaceWith(c);
    };
    if (img.complete) run(); else img.addEventListener("load", run);
  }

  global.HalftoneCover = { mount: mount, text: text, image: image, DEFAULTS: DEFAULTS };
})(window);
