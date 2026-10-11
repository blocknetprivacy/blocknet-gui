(function () {
  var FRAG = [
    'precision highp float;',
    'uniform vec2 r;',
    'uniform float t;',
    'uniform float ls;',
    'float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float caustic(vec2 uv) {',
    '  float tt = t * 0.06 + 23.0;',
    '  vec2 p = mod(uv * 6.2831, 6.2831) - 250.0;',
    '  vec2 i = p;',
    '  float cc = 1.0;',
    '  for (int k = 0; k < 5; k++) {',
    '    float s = tt * (1.0 - (3.5 / float(k + 1)));',
    '    i = p + vec2(cos(s - i.x) + sin(s + i.y), sin(s - i.y) + cos(s + i.x));',
    '    cc += 1.0 / length(vec2(p.x / (sin(i.x + s) / 0.005), p.y / (cos(i.y + s) / 0.005)));',
    '  }',
    '  cc /= 5.0;',
    '  cc = 1.17 - pow(cc, 1.4);',
    '  return clamp(pow(abs(cc), 6.0), 0.0, 1.0);',
    '}',
    'float dots(vec2 uv, float cells, float off) {',
    '  vec2 g = uv * cells + off;',
    '  vec2 id = floor(g);',
    '  vec2 jit = vec2(h(id), h(id + 5.3)) - 0.5;',
    '  vec2 center = (id + 0.5 + jit * 0.7 - off) / cells;',
    '  float v = caustic(center * 0.9);',
    '  float keep = smoothstep(h(id + 9.1) - 0.12, h(id + 9.1) + 0.12, v * 1.4);',
    '  float d = length(fract(g) - 0.5 - jit * 0.7);',
    '  return smoothstep(0.22, 0.12, d) * keep;',
    '}',
    'void main() {',
    '  vec2 uv = (gl_FragCoord.xy - 0.5 * r) / r.y;',
    '  float d = length(uv);',
    '  float acc = max(dots(uv, 64.0, 0.0), dots(uv, 101.0, 17.0));',
    '  acc *= smoothstep(0.15, 0.6, d) * smoothstep(1.05, 0.45, d) * smoothstep(ls * 0.75, ls * 1.6, d);',
    '  gl_FragColor = vec4(vec3(0.2 * clamp(acc, 0.0, 1.0)), 1.0);',
    '}'
  ].join('\n');

  window.startLoader = function (canvas, logoPx) {
    var gl = canvas.getContext('webgl', { antialias: false, powerPreference: 'low-power' });
    if (!gl) return function () {};
    function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
    var prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }'));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return function () {};
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var ur = gl.getUniformLocation(prog, 'r'), ut = gl.getUniformLocation(prog, 't'), uls = gl.getUniformLocation(prog, 'ls');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var running = true, raf = 0, last = 0, t0 = performance.now();

    function draw(now) {
      var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      var w = Math.round(canvas.clientWidth * dpr), hh = Math.round(canvas.clientHeight * dpr);
      if (!w || !hh) return;
      if (canvas.width !== w || canvas.height !== hh) { canvas.width = w; canvas.height = hh; }
      gl.viewport(0, 0, w, hh);
      gl.uniform2f(ur, w, hh);
      gl.uniform1f(ut, reduce ? 0 : (now - t0) / 1000);
      gl.uniform1f(uls, logoPx / canvas.clientHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function frame(now) {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      if (now - last < 33) return;
      last = now;
      draw(now);
    }

    function onResize() { if (reduce) draw(performance.now()); }

    if (reduce) {
      draw(performance.now());
      window.addEventListener('resize', onResize);
    } else {
      raf = requestAnimationFrame(frame);
    }

    return function stop() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    };
  };
})();
