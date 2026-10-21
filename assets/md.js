/* 极简 markdown → HTML（仅用于渲染书籍「导读」正文；零依赖、防注入）
   支持：标题 #~######、段落、无序/有序列表、- 引用、行内 **粗** *斜* `代码` [文字](http) */
window.HXWMD = function (src) {
  if (!src) return '';
  var lines = String(src).replace(/\r\n/g, '\n').split('\n');
  var html = '', i = 0;
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }
  function isSpecial(l) { return /^(#{1,6}\s|>\s?|\d+\.\s|[-*]\s)/.test(l); }
  while (i < lines.length) {
    var line = lines[i];
    var h = line.match(/^(#{1,6})\s(.*)$/);
    if (h) { var lv = h[1].length; html += '<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>'; i++; continue; }
    if (/^>\s?/.test(line)) {
      var qb = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { qb.push(lines[i].replace(/^>\s?/, '')); i++; }
      html += '<blockquote>' + inline(qb.join(' ')) + '</blockquote>';
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      var ob = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) { ob.push('<li>' + inline(lines[i].replace(/^\d+\.\s/, '')) + '</li>'); i++; }
      html += '<ol>' + ob.join('') + '</ol>'; continue;
    }
    if (/^[-*]\s/.test(line)) {
      var ub = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) { ub.push('<li>' + inline(lines[i].replace(/^[-*]\s/, '')) + '</li>'); i++; }
      html += '<ul>' + ub.join('') + '</ul>'; continue;
    }
    if (line.trim() === '') { i++; continue; }
    var pb = [];
    while (i < lines.length && lines[i].trim() !== '' && !isSpecial(lines[i])) { pb.push(lines[i]); i++; }
    html += '<p>' + inline(pb.join(' ')) + '</p>';
  }
  return html;
};
