(() => {
  const practiceCard = document.querySelector(".practice-card");
  if (!practiceCard || document.querySelector(".practice-library-launch")) return;

  const launch = document.createElement("a");
  launch.className = "practice-library-launch";
  launch.href = "./student-practice.html";
  launch.target = "_blank";
  launch.rel = "noopener";
  launch.innerHTML = '<div class="practice-library-icon">✦</div><div><p class="eyebrow">QUESTION BANK</p><h2>进入完整雅思口语题库</h2><p>继续使用原来的 Part 1、Part 2 &amp; 3、全真模拟、语音播放、隐藏题目与答案、一键导入等全部功能。</p></div><span>开始练习 →</span>';
  practiceCard.before(launch);
})();
