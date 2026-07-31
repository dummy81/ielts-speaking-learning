const classroomConfig = window.SUPABASE_CONFIG || {};
const classroomSupabase = window.supabase;
const classroomClient = classroomSupabase && classroomConfig.url && classroomConfig.anonKey ? classroomSupabase.createClient(classroomConfig.url, classroomConfig.anonKey) : null;
const classroomState = {profile:null, questions:[], students:[], filtered:[], currentId:"", draftQuestionId:"", answersVisible:false, sending:false};
const classroom$ = id => document.getElementById(id);

function classroomEscape(value) { return String(value || "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[char])); }
function classroomCue(line) { return /^(?:you should|and explain|and say|and describe|where|when|who|what|why|how|whether)\b/i.test(line) || /^(?:你应该说|你需要说|并解释|在哪里|什么时候|谁|什么|为什么|如何)/.test(line) || /[:：]$/.test(line); }

function currentClassroomQuestion() { return classroomState.filtered.find(item => item.id === classroomState.currentId) || null; }

function renderClassroomStudents() {
  const select = classroom$("classroomStudent");
  const selected = select.value;
  select.innerHTML = classroomState.students.length ? `<option value="">请选择学生</option>${classroomState.students.map(student => `<option value="${classroomEscape(student.id)}">${classroomEscape(student.display_name || student.username)}</option>`).join("")}` : '<option value="">暂无学生账号</option>';
  if (classroomState.students.some(student => student.id === selected)) select.value = selected;
}

function syncStudentVersionDraft() {
  const question = currentClassroomQuestion();
  if (!question || classroomState.draftQuestionId === question.id) return;
  classroom$("classroomStudentVersion").value = question.answer_notes || "";
  classroomState.draftQuestionId = question.id;
  classroom$("classroomSendStatus").textContent = question.answer_notes ? "已载入固定参考答案，可按学生情况修改后发送。" : "本题暂无固定答案，请编辑学生版讲义后发送。";
}

function renderClassroomList() {
  const query = classroom$("classroomSearch").value.trim().toLowerCase();
  const part = classroom$("classroomPart").value;
  classroomState.filtered = classroomState.questions.filter(question => (part === "all" || question.part === part) && (!query || [question.title, question.prompt, ...(question.tags || [])].join(" ").toLowerCase().includes(query)));
  if (!classroomState.filtered.some(question => question.id === classroomState.currentId)) classroomState.currentId = classroomState.filtered[0]?.id || "";
  classroom$("classroomTopicList").innerHTML = classroomState.filtered.length ? classroomState.filtered.map(question => `<button class="classroom-topic ${question.id === classroomState.currentId ? "active" : ""}" data-classroom-question="${question.id}" type="button"><span>${classroomEscape(question.part)}</span><b>${classroomEscape(question.title)}</b></button>`).join("") : '<div class="classroom-empty"><b>没有匹配题目</b><span>更换筛选条件或返回题库添加题目。</span></div>';
  renderClassroomCard();
}

function renderClassroomCard() {
  const question = currentClassroomQuestion();
  const card = classroom$("classroomCard");
  const index = classroomState.filtered.findIndex(item => item.id === classroomState.currentId);
  classroom$("classroomCounter").textContent = question ? `${index + 1} / ${classroomState.filtered.length}` : "0 / 0";
  classroom$("classroomPrevious").disabled = index <= 0;
  classroom$("classroomNext").disabled = index < 0 || index >= classroomState.filtered.length - 1;
  if (!question) { card.innerHTML = '<div class="classroom-empty"><b>还没有可展示的题目</b><span>请先在教师工作台添加或导入题目。</span></div>'; return; }
  syncStudentVersionDraft();
  const promptLines = String(question.prompt || "").split("\n").map(line => line.trim()).filter(Boolean);
  const prompt = promptLines.map((line, lineIndex) => `<p class="${lineIndex && classroomCue(line) ? "cue" : ""}">${classroomEscape(line)}</p>`).join("");
  const p3 = (question.p3_questions || []).filter(Boolean);
  const answer = classroomState.answersVisible && question.answer_notes ? `<section class="classroom-answers"><b>参考答案 / 课堂讲解</b>\n${classroomEscape(question.answer_notes)}</section>` : "";
  card.innerHTML = `<span class="classroom-part">${classroomEscape(question.part)}</span><h2>${classroomEscape(question.title)}</h2><section class="classroom-prompt">${prompt}</section>${p3.length ? `<section class="classroom-p3"><h3>PART 3 · FOLLOW-UP QUESTIONS</h3>${p3.map(item => `<p>${classroomEscape(item)}</p>`).join("")}</section>` : ""}${answer}`;
}

async function loadClassroom() {
  if (!classroomClient) { classroom$("classroomStatus").textContent = "缺少 Supabase 配置。"; return; }
  const sessionResult = await classroomClient.auth.getSession();
  if (!sessionResult.data.session) { window.location.replace("./index.html"); return; }
  const profileResult = await classroomClient.from("profiles").select("id,display_name,role").eq("id", sessionResult.data.session.user.id).single();
  if (profileResult.error || profileResult.data?.role !== "teacher") { classroom$("classroomStatus").textContent = "课堂展示仅供教师账号使用。"; return; }
  classroomState.profile = profileResult.data;
  const [questionsResult, studentsResult] = await Promise.all([
    classroomClient.from("questions").select("id,part,title,prompt,tags,p3_questions,answer_notes,created_at").eq("teacher_id", classroomState.profile.id).order("created_at", {ascending:false}),
    classroomClient.from("profiles").select("id,display_name,username").eq("role", "student").order("display_name")
  ]);
  const failed = [questionsResult, studentsResult].find(result => result.error);
  if (failed) { classroom$("classroomStatus").textContent = failed.error.message; return; }
  classroomState.questions = questionsResult.data || [];
  classroomState.students = studentsResult.data || [];
  renderClassroomStudents();
  classroom$("classroomStatus").textContent = `${classroomState.profile.display_name}的题库 · ${classroomState.questions.length} 道题目`;
  renderClassroomList();
}

async function sendStudentVersion() {
  if (classroomState.sending) return;
  const question = currentClassroomQuestion();
  const studentId = classroom$("classroomStudent").value;
  const editedText = classroom$("classroomStudentVersion").value.trim();
  if (!question) { classroom$("classroomSendStatus").textContent = "请先选择一道题目。"; return; }
  if (!studentId) { classroom$("classroomSendStatus").textContent = "请先选择要接收讲义的学生。"; return; }
  if (!editedText) { classroom$("classroomSendStatus").textContent = "请填写学生版讲义内容后再发送。"; return; }
  classroomState.sending = true;
  const button = classroom$("classroomSendVersion");
  button.disabled = true;
  button.textContent = "正在发送…";
  const student = classroomState.students.find(item => item.id === studentId);
  const assignmentResult = await classroomClient.from("assignments").insert({
    teacher_id: classroomState.profile.id,
    student_id: studentId,
    title: `课堂定制讲义 · ${question.title}`,
    instructions: "老师根据你的课堂表现准备了定制讲义。",
    due_at: null
  }).select().single();
  if (assignmentResult.error) {
    classroom$("classroomSendStatus").textContent = assignmentResult.error.message;
    button.disabled = false;
    button.textContent = "发送给该学生";
    classroomState.sending = false;
    return;
  }
  const snapshot = {
    id: question.id,
    part: question.part,
    title: question.title,
    prompt: question.prompt,
    tags: Array.isArray(question.tags) ? question.tags : [],
    p3_questions: Array.isArray(question.p3_questions) ? question.p3_questions : [],
    student_version: editedText
  };
  const questionResult = await classroomClient.from("assignment_questions").insert({assignment_id:assignmentResult.data.id, question_id:question.id, question_snapshot:snapshot, position:0});
  if (questionResult.error) {
    await classroomClient.from("assignments").delete().eq("id", assignmentResult.data.id);
    classroom$("classroomSendStatus").textContent = questionResult.error.message;
  } else {
    classroom$("classroomSendStatus").textContent = `已将学生版讲义发送给${student?.display_name || "该学生"}，不会改变固定参考答案。`;
  }
  button.disabled = false;
  button.textContent = "发送给该学生";
  classroomState.sending = false;
}

classroom$("classroomSearch").addEventListener("input", renderClassroomList);
classroom$("classroomPart").addEventListener("change", renderClassroomList);
classroom$("classroomTopicList").addEventListener("click", event => { const button = event.target.closest("[data-classroom-question]"); if (!button) return; classroomState.currentId = button.dataset.classroomQuestion; renderClassroomList(); });
classroom$("classroomPrevious").addEventListener("click", () => { const index = classroomState.filtered.findIndex(item => item.id === classroomState.currentId); if (index > 0) { classroomState.currentId = classroomState.filtered[index - 1].id; renderClassroomList(); } });
classroom$("classroomNext").addEventListener("click", () => { const index = classroomState.filtered.findIndex(item => item.id === classroomState.currentId); if (index < classroomState.filtered.length - 1) { classroomState.currentId = classroomState.filtered[index + 1].id; renderClassroomList(); } });
classroom$("classroomToggleAnswers").addEventListener("click", () => { classroomState.answersVisible = !classroomState.answersVisible; classroom$("classroomToggleAnswers").textContent = classroomState.answersVisible ? "隐藏参考答案" : "显示参考答案"; classroom$("classroomToggleAnswers").classList.toggle("active", classroomState.answersVisible); renderClassroomCard(); });
classroom$("classroomFullscreen").addEventListener("click", async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); });
classroom$("classroomSendVersion").addEventListener("click", sendStudentVersion);
loadClassroom();
