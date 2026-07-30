const config = window.SUPABASE_CONFIG || {};
const supabaseFactory = window.supabase;
const mediaBucket = "speaking-media";
const entryRole = ["admin", "teacher", "student"].includes(new URLSearchParams(window.location.search).get("entry")) ? new URLSearchParams(window.location.search).get("entry") : "";
const $ = id => document.getElementById(id);
const state = {
  client: null,
  session: null,
  profile: null,
  questions: [],
  students: [],
  assignments: [],
  submissions: [],
  selectedAssignmentId: "",
  selectedSubmissionId: "",
  selectedQuestionIds: new Set(),
  studentMode: "audio",
  recording: null,
  recorder: null,
  stream: null,
  chunks: [],
  recordingSeconds: 0,
  recordingTimer: null,
  feedbackRecorder: null,
  feedbackStream: null,
  feedbackChunks: [],
  feedbackVoiceBlob: null,
  feedbackVoiceUrl: "",
  feedbackTimer: null,
  feedbackSeconds: 0,
  adminUsers: [],
  platformSettings: null
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[character]));
}

function toast(message) {
  const node = $("toast");
  if (!node) return;
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 2800);
}

function authMessage(message, success = false) {
  const node = $("authMessage");
  if (!node) return;
  node.textContent = message;
  node.style.color = success ? "#08795d" : "#be5739";
}

function accountEmail(username) {
  return `${username.toLowerCase()}@accounts.ielts-studio.invalid`;
}

function formatDate(value) {
  if (!value) return "未设置";
  return new Intl.DateTimeFormat("zh-CN", {month:"short", day:"numeric"}).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) return "未设置截止时间";
  return new Intl.DateTimeFormat("zh-CN", {month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"}).format(new Date(value));
}

function formatDuration(seconds) {
  return `${Math.floor((seconds || 0) / 60)}:${String((seconds || 0) % 60).padStart(2, "0")}`;
}

function statusInfo(assignment) {
  const latest = (assignment.submissions || [])[0];
  if (latest?.feedback) return {label:"已反馈", className:"feedback"};
  if (latest) return {label:"已提交", className:"submitted"};
  return {label:"待完成", className:""};
}

function questionSnapshot(raw) {
  return {
    id: raw.id,
    part: raw.part,
    title: raw.title,
    prompt: raw.prompt,
    tags: Array.isArray(raw.tags) ? raw.tags : String(raw.tags || "").split(",").map(item => item.trim()).filter(Boolean),
    p3_questions: Array.isArray(raw.p3_questions) ? raw.p3_questions : String(raw.p3 || "").split("\n").map(item => item.trim()).filter(Boolean)
  };
}

function assignmentSnapshot(raw) {
  const assignmentQuestions = [...(raw.assignment_questions || [])].sort((first, second) => (first.position || 0) - (second.position || 0));
  const submissions = [...(raw.submissions || [])].sort((first, second) => new Date(second.created_at) - new Date(first.created_at)).map(submission => ({...submission, feedback: Array.isArray(submission.feedbacks) ? submission.feedbacks[0] : submission.feedbacks || null}));
  return {...raw, questions: assignmentQuestions.map(item => questionSnapshot(item.question_snapshot || {})), submissions};
}

function showOnly(view) {
  if ($("authPage")) $("authPage").classList.toggle("hidden", view !== "auth");
  if ($("studentApp")) $("studentApp").classList.toggle("hidden", view !== "student");
  if ($("teacherApp")) $("teacherApp").classList.toggle("hidden", view !== "teacher");
  if ($("adminApp")) $("adminApp").classList.toggle("hidden", view !== "admin");
}

async function getSignedUrl(path) {
  if (!path || !state.client) return "";
  const result = await state.client.storage.from(mediaBucket).createSignedUrl(path, 3600);
  return result.data?.signedUrl || "";
}

async function requireClient() {
  if (state.client) return true;
  authMessage("请先在 supabase-config.js 填写项目 URL 和 anon key。", false);
  return false;
}

async function signIn(event) {
  event.preventDefault();
  if (!(await requireClient())) return;
  const username = $("signInAccount").value.trim().toLowerCase();
  const password = $("signInPassword").value;
  const result = await state.client.auth.signInWithPassword({email: accountEmail(username), password});
  if (result.error) { authMessage("账号或密码不正确，请重试。"); return; }
  authMessage("登录成功。", true);
}

async function signUp(event) {
  event.preventDefault();
  if (!(await requireClient())) return;
  const displayName = $("signUpName").value.trim();
  const username = $("signUpAccount").value.trim().toLowerCase();
  const password = $("signUpPassword").value;
  const role = entryRole || $("signUpRole").value;
  const registrationCode = role === "teacher" ? $("signUpTeacherInvite")?.value.trim() : role === "admin" ? $("signUpAdminSetupCode")?.value.trim() : "";
  if (!/^[a-z0-9_]{3,24}$/i.test(username)) { authMessage("账号需为 3–24 位字母、数字或下划线。"); return; }
  if (password.length < 6) { authMessage("密码至少需要 6 位。"); return; }
  if ((role === "teacher" || role === "admin") && !registrationCode) { authMessage(role === "teacher" ? "请填写教师邀请码。" : "请填写管理员初始化码。"); return; }
  const result = await state.client.auth.signUp({email: accountEmail(username), password, options:{data:{username, display_name:displayName, role, registration_code:registrationCode}}});
  if (result.error) { authMessage(result.error.message.includes("already registered") ? "该账号已存在。" : result.error.message); return; }
  if (!result.data.session) { authMessage("账号已创建。若项目开启了邮箱确认，请在 Supabase 关闭 Confirm email 后再登录。", true); return; }
  authMessage("注册成功，正在进入工作台。", true);
  if ($("registrationPage")) window.location.replace("./index.html");
}

async function loadProfile() {
  const result = await state.client.from("profiles").select("*").eq("id", state.session.user.id).single();
  if (result.error) throw result.error;
  state.profile = result.data;
}

async function enterWorkspace() {
  try {
    await loadProfile();
    if ($("registrationPage")) {
      window.location.replace("./index.html");
      return;
    }
    if (entryRole && state.profile.role !== entryRole) {
      const roleName = {admin:"管理员", teacher:"教师", student:"学生"}[entryRole];
      authMessage(`此入口仅允许${roleName}账号登录。`);
      await state.client.auth.signOut();
      showOnly("auth");
      return;
    }
    if (state.profile.role === "admin") {
      showOnly("admin");
      $("adminGreeting").textContent = `${state.profile.display_name}，平台一切尽在掌握`;
      $("adminRailName").textContent = state.profile.display_name;
      $("adminAvatar").textContent = state.profile.display_name.slice(0, 1);
      await loadAdminData();
    } else if (state.profile.role === "teacher") {
      showOnly("teacher");
      $("teacherGreeting").textContent = `${state.profile.display_name}，今天也辛苦了`;
      $("teacherRailName").textContent = state.profile.display_name;
      $("teacherAvatar").textContent = state.profile.display_name.slice(0, 1);
      await loadTeacherData();
    } else {
      showOnly("student");
      $("studentGreeting").textContent = `你好，${state.profile.display_name}`;
      $("studentRailName").textContent = state.profile.display_name;
      $("studentAvatar").textContent = state.profile.display_name.slice(0, 1);
      await loadStudentData();
    }
  } catch (error) {
    console.error(error);
    toast("无法读取账号资料，请确认已经执行数据库脚本。");
    showOnly("auth");
  }
}

async function loadStudentData() {
  const result = await state.client.from("assignments").select("*, assignment_questions(*), submissions(*, feedbacks(*))").eq("student_id", state.profile.id).order("created_at", {ascending:false});
  if (result.error) { toast(result.error.message); return; }
  state.assignments = (result.data || []).map(assignmentSnapshot);
  renderStudent();
}

async function loadTeacherData() {
  const [questions, students, assignments, submissions] = await Promise.all([
    state.client.from("questions").select("*").eq("teacher_id", state.profile.id).order("created_at", {ascending:false}),
    state.client.from("profiles").select("id,display_name,username").eq("role", "student").order("display_name"),
    state.client.from("assignments").select("*, assignment_questions(*)").eq("teacher_id", state.profile.id).order("created_at", {ascending:false}),
    state.client.from("submissions").select("*, assignments!inner(id,title,teacher_id,student_id), feedbacks(*)").eq("assignments.teacher_id", state.profile.id).order("created_at", {ascending:false})
  ]);
  const failed = [questions, students, assignments, submissions].find(result => result.error);
  if (failed) { toast(failed.error.message); return; }
  state.questions = questions.data || [];
  state.students = students.data || [];
  state.assignments = (assignments.data || []).map(assignmentSnapshot);
  state.submissions = (submissions.data || []).map(submission => ({...submission, feedback:Array.isArray(submission.feedbacks) ? submission.feedbacks[0] : submission.feedbacks || null, student:state.students.find(student => student.id === submission.student_id)}));
  state.assignments = state.assignments.map(assignment => ({...assignment, submissions:state.submissions.filter(submission => submission.assignment_id === assignment.id)}));
  renderTeacher();
}

async function loadAdminData() {
  const [users, settings] = await Promise.all([
    state.client.from("profiles").select("id,username,display_name,role,created_at").order("created_at", {ascending:false}),
    state.client.from("platform_settings").select("teacher_invite_code,updated_at").eq("singleton", true).single()
  ]);
  const failed = [users, settings].find(result => result.error);
  if (failed) { toast(failed.error.message); return; }
  state.adminUsers = users.data || [];
  state.platformSettings = settings.data;
  renderAdmin();
}

function roleLabel(role) {
  return {admin:"管理员", teacher:"教师", student:"学生"}[role] || role;
}

function renderAdmin() {
  const users = state.adminUsers;
  const teachers = users.filter(user => user.role === "teacher").length;
  const students = users.filter(user => user.role === "student").length;
  $("adminMetrics").innerHTML = `<article class="admin-metric"><small>全部账号</small><b>${users.length}</b><small>平台当前用户</small></article><article class="admin-metric"><small>教师账号</small><b>${teachers}</b><small>可建立题库与作业</small></article><article class="admin-metric"><small>学生账号</small><b>${students}</b><small>可进入题库练习</small></article><article class="admin-metric"><small>教师邀请码</small><b>已启用</b><small>${state.platformSettings?.updated_at ? `更新于 ${formatDate(state.platformSettings.updated_at)}` : "等待加载"}</small></article>`;
  $("adminTeacherInviteCode").value = state.platformSettings?.teacher_invite_code || "";
  renderAdminUsers();
}

function renderAdminUsers() {
  const query = $("adminUserSearch").value.trim().toLowerCase();
  const users = state.adminUsers.filter(user => `${user.display_name} ${user.username}`.toLowerCase().includes(query));
  $("adminUserList").innerHTML = users.length ? users.map(user => `<article class="admin-user-row"><div class="admin-user-avatar ${user.role}">${escapeHtml(user.display_name.slice(0, 1))}</div><div><b>${escapeHtml(user.display_name)}</b><small>@${escapeHtml(user.username)} · ${roleLabel(user.role)}</small></div><time>${formatDate(user.created_at)}</time>${user.role === "admin" ? `<span class="admin-protected">受保护</span>` : `<button class="tiny-button delete" data-admin-user-delete="${user.id}" type="button">删除</button>`}</article>`).join("") : `<div class="empty">没有匹配的用户。</div>`;
}

async function saveTeacherInvite(event) {
  event.preventDefault();
  const code = $("adminTeacherInviteCode").value.trim();
  if (code.length < 4 || code.length > 64) { toast("邀请码长度需为 4–64 位。"); return; }
  const result = await state.client.from("platform_settings").update({teacher_invite_code:code}).eq("singleton", true);
  if (result.error) { toast(result.error.message); return; }
  toast("教师邀请码已更新。");
  await loadAdminData();
}

async function createManagedUser(event) {
  event.preventDefault();
  const result = await state.client.rpc("admin_create_user", {
    p_username: $("adminNewUsername").value.trim(),
    p_display_name: $("adminNewDisplayName").value.trim(),
    p_role: $("adminNewRole").value,
    p_password: $("adminNewPassword").value
  });
  if (result.error) { toast(result.error.message); return; }
  $("adminCreateUserForm").reset();
  toast("账号已创建。");
  await loadAdminData();
}

async function deleteManagedUser(userId) {
  const user = state.adminUsers.find(item => item.id === userId);
  if (!user || !window.confirm(`确认删除 ${user.display_name} 的账号吗？此操作无法恢复。`)) return;
  const result = await state.client.rpc("admin_delete_user", {p_user_id:userId});
  if (result.error) { toast(result.error.message); return; }
  toast("账号已删除。");
  await loadAdminData();
}

function setRegistrationRole(role) {
  if (!$("signUpRole")) return;
  $("signUpRole").value = role;
  document.querySelectorAll("[data-registration-role]").forEach(button => button.classList.toggle("active", button.dataset.registrationRole === role));
  $("teacherInviteField")?.classList.toggle("hidden", role !== "teacher");
  $("adminSetupField")?.classList.toggle("hidden", role !== "admin");
  const notes = {
    student:"学生账号创建后即可使用题库练习和老师布置的任务。",
    teacher:"教师账号需验证邀请码，验证通过后可建立题库、布置作业和批改。",
    admin:"管理员只在平台首次初始化时开放。创建成功后，初始化入口会自动锁定。"
  };
  if ($("registrationNote")) $("registrationNote").textContent = notes[role];
}

function renderStudent() {
  const assignments = state.assignments;
  const submitted = assignments.filter(assignment => assignment.submissions?.length).length;
  const feedback = assignments.filter(assignment => assignment.submissions?.some(submission => submission.feedback)).length;
  $("studentStats").innerHTML = `<article class="student-stat"><small>待完成作业</small><b>${assignments.filter(assignment => !assignment.submissions?.length).length}</b><small>来自老师的安排</small></article><article class="student-stat"><small>已提交</small><b>${submitted}</b><small>本月口语录制</small></article><article class="student-stat"><small>收到反馈</small><b>${feedback}</b><small>可以开始复练</small></article><article class="student-stat"><small>完成率</small><b>${assignments.length ? Math.round(submitted / assignments.length * 100) : 0}%</b><small>按作业计算</small></article>`;
  $("studentTaskCount").textContent = `${assignments.length} 项`;
  $("studentTaskList").innerHTML = assignments.length ? assignments.map(assignment => { const status = statusInfo(assignment); return `<article class="student-task-card"><i>${assignment.questions?.length || "·"}</i><div><b>${escapeHtml(assignment.title)}</b><small>${assignment.questions?.length || 0} 道题 · 截止 ${formatDateTime(assignment.due_at)}</small></div><span class="status ${status.className}">${status.label}</span></article>`; }).join("") : `<div class="empty">老师还没有给你布置作业。</div>`;
  const previous = $("studentAssignmentSelect").value;
  $("studentAssignmentSelect").innerHTML = assignments.length ? assignments.map(assignment => `<option value="${assignment.id}">${escapeHtml(assignment.title)}</option>`).join("") : `<option value="">暂无作业</option>`;
  state.selectedAssignmentId = assignments.some(assignment => assignment.id === previous) ? previous : assignments[0]?.id || "";
  $("studentAssignmentSelect").value = state.selectedAssignmentId;
  $("studentAssignmentSelect").disabled = !assignments.length;
  $("studentRecordBtn").disabled = !assignments.length;
  $("studentSubmitBtn").disabled = !assignments.length;
  renderStudentAssignment();
  renderStudentFeedback();
}

function renderStudentAssignment() {
  const assignment = state.assignments.find(item => item.id === state.selectedAssignmentId);
  $("studentAssignmentDue").textContent = assignment ? `截止 ${formatDateTime(assignment.due_at)}` : "";
  $("recordStatusTag").textContent = assignment ? statusInfo(assignment).label : "请选择作业";
  $("studentAssignmentQuestions").innerHTML = assignment ? `<h3>${escapeHtml(assignment.title)}</h3><ol>${(assignment.questions || []).map(question => `<li><strong>${escapeHtml(question.part || "口语题")}</strong> · ${escapeHtml(question.title || "未命名题目")}<br>${escapeHtml(question.prompt || "")}${question.p3_questions?.length ? `<br><small>关联 P3：${question.p3_questions.length} 道追问</small>` : ""}</li>`).join("")}</ol>` : "选择作业后，这里会显示题目。";
}

async function renderStudentFeedback() {
  const cards = [];
  for (const assignment of state.assignments) {
    for (const submission of assignment.submissions || []) {
      if (!submission.feedback) continue;
      const voiceUrl = await getSignedUrl(submission.feedback.voice_path);
      cards.push(`<article class="feedback-card"><span class="status feedback">老师已反馈</span><h3>${escapeHtml(assignment.title)}</h3><p>${escapeHtml(submission.feedback.feedback_text)}</p><div class="score-row"><span>流利 ${submission.feedback.fluency}</span><span>词汇 ${submission.feedback.vocabulary}</span><span>语法 ${submission.feedback.grammar}</span><span>发音 ${submission.feedback.pronunciation}</span></div>${voiceUrl ? `<audio controls src="${voiceUrl}"></audio>` : ""}</article>`);
    }
  }
  $("studentFeedbackList").innerHTML = cards.length ? cards.join("") : `<div class="empty">老师的反馈会出现在这里。先完成一次录制吧。</div>`;
}

function setStudentMode(mode) {
  state.studentMode = mode;
  document.querySelectorAll("[data-student-mode]").forEach(button => button.classList.toggle("active", button.dataset.studentMode === mode));
  $("studentRecordStatus").textContent = `已选择${mode === "video" ? "视频" : "语音"}。点击开始录制。`;
}

async function toggleStudentRecording() {
  if (state.recorder?.state === "recording") { state.recorder.stop(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast("当前浏览器不支持录音，请使用 HTTPS 下的 Chrome 或 Edge。"); return; }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia(state.studentMode === "video" ? {audio:true, video:{facingMode:"user"}} : {audio:true});
    state.chunks = [];
    state.recordingSeconds = 0;
    state.recorder = new MediaRecorder(state.stream);
    state.recorder.ondataavailable = event => { if (event.data.size) state.chunks.push(event.data); };
    state.recorder.onstop = () => {
      state.stream.getTracks().forEach(track => track.stop());
      const blob = new Blob(state.chunks, {type:state.recorder.mimeType || `${state.studentMode}/webm`});
      state.recording = {blob, type:state.studentMode, duration:state.recordingSeconds, url:URL.createObjectURL(blob)};
      clearInterval(state.recordingTimer);
      $("studentRecordBtn").textContent = "● 重新录制";
      $("studentRecordStatus").textContent = `录制完成 · ${formatDuration(state.recordingSeconds)}，确认后提交。`;
      const media = state.studentMode === "video" ? `<video controls playsinline src="${state.recording.url}"></video>` : `<audio controls src="${state.recording.url}"></audio>`;
      $("studentMediaPreview").innerHTML = `<strong>本地预览</strong>${media}`;
      $("studentMediaPreview").classList.add("show");
    };
    state.recorder.start();
    state.recordingTimer = setInterval(() => { state.recordingSeconds += 1; $("studentRecordStatus").textContent = `正在录制 · ${formatDuration(state.recordingSeconds)}，再次点击停止。`; }, 1000);
    $("studentRecordBtn").textContent = "■ 停止录制";
  } catch { toast("无法访问麦克风或摄像头，请检查浏览器权限。"); }
}

async function submitStudentRecording() {
  const assignment = state.assignments.find(item => item.id === state.selectedAssignmentId);
  if (!assignment) { toast("请先选择一项作业。"); return; }
  if (!state.recording) { toast("请先完成语音或视频录制。"); return; }
  const extension = state.recording.type === "video" ? "webm" : "webm";
  const path = `${state.profile.id}/${assignment.id}/${crypto.randomUUID()}.${extension}`;
  const upload = await state.client.storage.from(mediaBucket).upload(path, state.recording.blob, {contentType:state.recording.blob.type || `${state.recording.type}/webm`});
  if (upload.error) { toast(upload.error.message); return; }
  const result = await state.client.from("submissions").insert({assignment_id:assignment.id, student_id:state.profile.id, media_type:state.recording.type, media_path:path, duration_seconds:state.recording.duration, reflection:$("studentReflection").value.trim()});
  if (result.error) { toast(result.error.message); return; }
  state.recording = null;
  $("studentReflection").value = "";
  $("studentMediaPreview").classList.remove("show");
  $("studentMediaPreview").innerHTML = "";
  $("studentRecordBtn").textContent = "● 开始录制";
  $("studentRecordStatus").textContent = "已提交，老师可以在教师端查看。";
  toast("作业提交成功。");
  await loadStudentData();
}

function renderTeacher() {
  $("teacherMetrics").innerHTML = `<article class="teacher-metric"><small>学生人数</small><b>${state.students.length}</b><small>可布置作业的学生</small></article><article class="teacher-metric"><small>题库题目</small><b>${state.questions.length}</b><small>属于当前教师</small></article><article class="teacher-metric"><small>当前作业</small><b>${state.assignments.length}</b><small>已发送的任务</small></article><article class="teacher-metric"><small>待批改</small><b>${state.submissions.filter(submission => !submission.feedback).length}</b><small>学生已提交</small></article>`;
  renderTeacherQuestions();
  renderAssignmentPicker();
  renderStudents();
  renderTeacherSubmissions();
}

function renderTeacherQuestions() {
  const search = $("questionSearch").value.trim().toLowerCase();
  const questions = state.questions.filter(question => !search || [question.title, question.prompt, question.part, ...(question.tags || [])].join(" ").toLowerCase().includes(search));
  $("teacherQuestionList").innerHTML = questions.length ? questions.map(question => `<article class="question-row"><div class="question-row-top"><span><span class="part-pill ${question.part === "Part 2 & 3" ? "p2" : ""}">${escapeHtml(question.part)}</span><b>${escapeHtml(question.title)}</b></span><span class="tag-pill">${escapeHtml((question.tags || []).join(" · ") || "未分类")}</span></div><p>${escapeHtml(question.prompt)}</p>${question.p3_questions?.length ? `<p>关联 P3：${question.p3_questions.length} 道追问</p>` : ""}<div class="row-actions"><button class="tiny-button" data-question-edit="${question.id}" type="button">编辑</button><button class="tiny-button delete" data-question-delete="${question.id}" type="button">删除</button></div></article>`).join("") : `<div class="empty">没有匹配题目。可以手动新增或导入 Word。</div>`;
}

function renderAssignmentPicker() {
  const search = $("assignmentQuestionSearch").value.trim().toLowerCase();
  const questions = state.questions.filter(question => !search || [question.title, question.prompt, question.part, ...(question.tags || [])].join(" ").toLowerCase().includes(search));
  $("assignmentQuestionPicker").innerHTML = questions.length ? questions.map(question => `<label class="picker-question"><input type="checkbox" data-assignment-question="${question.id}" ${state.selectedQuestionIds.has(question.id) ? "checked" : ""}><span><b>${escapeHtml(question.title)}</b><small>${escapeHtml(question.part)} · ${(question.tags || []).map(escapeHtml).join(" · ")}<br>${escapeHtml(question.prompt)}</small></span></label>`).join("") : `<div class="empty">没有匹配题目。</div>`;
  $("questionSelectionCount").textContent = `已选 ${state.selectedQuestionIds.size} 题`;
  $("assignmentPickerHint").textContent = state.selectedQuestionIds.size ? `将发送 ${state.selectedQuestionIds.size} 道题目` : "至少选择一道题目";
}

function renderStudents() {
  const currentStudentId = $("assignmentStudent").value;
  $("assignmentStudent").innerHTML = state.students.length ? state.students.map(student => `<option value="${student.id}">${escapeHtml(student.display_name)} · @${escapeHtml(student.username)}</option>`).join("") : `<option value="">暂无学生账号</option>`;
  if (state.students.some(student => student.id === currentStudentId)) $("assignmentStudent").value = currentStudentId;
  const cards = state.students.map(student => {
    const assignments = state.assignments.filter(assignment => assignment.student_id === student.id);
    return `<section class="student-column"><div class="student-column-head"><b>${escapeHtml(student.display_name)}</b><span class="soft-pill">${assignments.length} 项</span></div><div class="student-column-body">${assignments.length ? assignments.map(assignment => { const status = statusInfo(assignment); return `<article class="teacher-task-card"><span class="status ${status.className}">${status.label}</span><b>${escapeHtml(assignment.title)}</b><small>截止 ${formatDateTime(assignment.due_at)}</small><p>${escapeHtml((assignment.questions || []).map(question => question.title).join(" · ") || "未附题目")}</p></article>`; }).join("") : `<div class="empty">尚未布置作业。</div>`}</div></section>`;
  }).join("");
  $("teacherStudentBoard").innerHTML = cards || `<div class="empty">还没有学生账号，请先让学生注册。</div>`;
}

function renderTeacherSubmissions() {
  if (!state.selectedSubmissionId && state.submissions[0]) state.selectedSubmissionId = state.submissions[0].id;
  $("teacherSubmissionList").innerHTML = state.submissions.length ? state.submissions.map(submission => `<button class="submission-row ${submission.id === state.selectedSubmissionId ? "active" : ""}" data-submission-id="${submission.id}" type="button"><span>${escapeHtml(submission.student?.display_name || "S")}</span><span><b>${escapeHtml(submission.assignments?.title || "口语作业")}</b><small>${formatDateTime(submission.created_at)} · ${submission.media_type === "video" ? "视频" : "语音"}</small></span><span class="status ${submission.feedback ? "feedback" : ""}">${submission.feedback ? "已反馈" : "待批改"}</span></button>`).join("") : `<div class="empty">还没有学生提交。</div>`;
  renderTeacherReview();
}

async function renderTeacherReview() {
  const submission = state.submissions.find(item => item.id === state.selectedSubmissionId);
  if (!submission) { $("teacherReviewPanel").innerHTML = `<div class="empty-review">从左侧选择一份学生提交，开始评分和反馈。</div>`; return; }
  const mediaUrl = await getSignedUrl(submission.media_path);
  const feedback = submission.feedback;
  const media = mediaUrl ? (submission.media_type === "video" ? `<video controls playsinline src="${mediaUrl}"></video>` : `<audio controls src="${mediaUrl}"></audio>`) : `<p class="empty">媒体签名链接暂不可用。</p>`;
  $("teacherReviewPanel").innerHTML = `<div class="review-head"><div><span class="status ${feedback ? "feedback" : ""}">${feedback ? "已完成反馈" : "等待批改"}</span><h3>${escapeHtml(submission.student?.display_name || "学生")} · ${escapeHtml(submission.assignments?.title || "口语作业")}</h3><p>${formatDateTime(submission.created_at)} · ${submission.media_type === "video" ? "视频" : "语音"} · ${formatDuration(submission.duration_seconds)}</p></div></div><div class="review-body"><div class="review-media"><strong>学生录制</strong>${media}<p class="tiny">学生复盘：${escapeHtml(submission.reflection || "未填写")}</p></div><div class="review-scores"><label>Fluency<select id="scoreFluency">${scoreOptions(feedback?.fluency)}</select></label><label>Vocabulary<select id="scoreVocabulary">${scoreOptions(feedback?.vocabulary)}</select></label><label>Grammar<select id="scoreGrammar">${scoreOptions(feedback?.grammar)}</select></label><label>Pronunciation<select id="scorePronunciation">${scoreOptions(feedback?.pronunciation)}</select></label></div><div class="review-feedback"><textarea id="teacherFeedbackText" placeholder="先肯定一个做得好的点，再给出一个下一次可以执行的建议。">${escapeHtml(feedback?.feedback_text || "")}</textarea><div class="form-actions"><button class="button quiet" id="teacherVoiceBtn" type="button">● 录制语音意见</button><button class="button primary" id="teacherSendFeedback" type="button">发送反馈</button></div><div class="feedback-voice-preview" id="feedbackVoicePreview">${state.feedbackVoiceUrl ? `<audio controls src="${state.feedbackVoiceUrl}"></audio>` : feedback?.voice_path ? "已有语音反馈" : ""}</div></div></div>`;
}

function scoreOptions(value) {
  const selected = value || 6;
  return [5.5,6,6.5,7,7.5,8,8.5,9].map(score => `<option value="${score}" ${Number(selected) === score ? "selected" : ""}>${score.toFixed(1)}</option>`).join("");
}

async function saveQuestion(event) {
  event.preventDefault();
  const payload = {teacher_id:state.profile.id, part:$("questionPart").value, title:$("questionTitle").value.trim(), prompt:$("questionPrompt").value.trim(), tags:$("questionTags").value.split(",").map(item => item.trim()).filter(Boolean), p3_questions:$("questionP3").value.split("\n").map(item => item.trim()).filter(Boolean)};
  if (!payload.title || !payload.prompt) { toast("请填写题目名称和题干。"); return; }
  const editingId = $("editingQuestionId").value;
  const result = editingId ? await state.client.from("questions").update(payload).eq("id", editingId).eq("teacher_id", state.profile.id) : await state.client.from("questions").insert(payload);
  if (result.error) { toast(result.error.message); return; }
  resetQuestionForm();
  await loadTeacherData();
  toast(editingId ? "题目已更新。" : "题目已加入私有题库。");
}

function resetQuestionForm() {
  $("editingQuestionId").value = "";
  $("questionPart").value = "Part 1";
  $("questionTags").value = "";
  $("questionTitle").value = "";
  $("questionPrompt").value = "";
  $("questionP3").value = "";
  $("questionSaveBtn").textContent = "保存题目";
}

function editQuestion(id) {
  const question = state.questions.find(item => item.id === id);
  if (!question) return;
  $("editingQuestionId").value = question.id;
  $("questionPart").value = question.part;
  $("questionTags").value = (question.tags || []).join(", ");
  $("questionTitle").value = question.title;
  $("questionPrompt").value = question.prompt;
  $("questionP3").value = (question.p3_questions || []).join("\n");
  $("questionSaveBtn").textContent = "保存修改";
  document.querySelector("#questionBank").scrollIntoView({behavior:"smooth", block:"start"});
}

async function deleteQuestion(id) {
  const question = state.questions.find(item => item.id === id);
  if (!question || !window.confirm(`删除题目“${question.title}”？已发送的作业不会受影响。`)) return;
  const result = await state.client.from("questions").delete().eq("id", id).eq("teacher_id", state.profile.id);
  if (result.error) { toast(result.error.message); return; }
  state.selectedQuestionIds.delete(id);
  await loadTeacherData();
  toast("题目已删除。");
}

function parseImportedQuestions(text, part) {
  const normalized = text.replace(/\r/g, "").replace(/\t/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];
  if (part === "Part 1") {
    let topic = "";
    return normalized.split("\n").map(line => line.trim()).filter(Boolean).filter(line => !/^P(?:art)?\s*1\b/i.test(line)).flatMap(line => {
      if (!/[?？]/.test(line)) { topic = line; return []; }
      return [{part:"Part 1", title:topic || line.replace(/[?？].*/, "").slice(0, 48) || "Part 1 question", prompt:line, tags:topic ? [topic] : [], p3_questions:[]}];
    });
  }
  return normalized.split(/\n\s*\n|(?=^\s*(?:Describe|Talk about)\b)/im).map(block => block.trim()).filter(Boolean).map(block => {
    const lines = block.split("\n").map(line => line.trim()).filter(line => line && !/^P(?:art)?\s*[23]\b/i.test(line));
    const prompt = lines.join(" ");
    return {part:"Part 2 & 3", title:lines[0]?.replace(/^Describe\s+/i, "").slice(0, 60) || "Part 2 & 3 question", prompt, tags:[], p3_questions:[]};
  });
}

async function importQuestions() {
  const file = $("wordImportInput").files[0];
  if (!file) { toast("请选择 .docx、.txt 或 .md 文件。"); return; }
  try {
    const text = file.name.toLowerCase().endsWith(".docx") ? (window.mammoth ? (await window.mammoth.extractRawText({arrayBuffer:await file.arrayBuffer()})).value : "") : await file.text();
    const parsed = parseImportedQuestions(text, $("wordImportPart").value).map(question => ({...question, teacher_id:state.profile.id}));
    if (!parsed.length) { toast("没有识别到题目，请按格式提示整理文件。"); return; }
    const result = await state.client.from("questions").insert(parsed);
    if (result.error) { toast(result.error.message); return; }
    $("wordImportInput").value = "";
    await loadTeacherData();
    toast(`已导入 ${parsed.length} 道题目。`);
  } catch (error) { toast(error.message || "导入失败。"); }
}

async function createAssignment(event) {
  event.preventDefault();
  const questionIds = [...state.selectedQuestionIds];
  const studentId = $("assignmentStudent").value;
  if (!studentId || !questionIds.length) { toast("请选择学生，并至少勾选一道题目。"); return; }
  const selectedQuestions = state.questions.filter(question => questionIds.includes(question.id));
  const student = state.students.find(item => item.id === studentId);
  const title = $("assignmentTitle").value.trim() || `口语任务 · ${selectedQuestions[0]?.title || "本周练习"}`;
  const dueValue = $("assignmentDue").value;
  const assignmentResult = await state.client.from("assignments").insert({teacher_id:state.profile.id, student_id:studentId, title, instructions:$("assignmentInstructions").value.trim(), due_at:dueValue ? new Date(dueValue).toISOString() : null}).select().single();
  if (assignmentResult.error) { toast(assignmentResult.error.message); return; }
  const rows = selectedQuestions.map((question, index) => ({assignment_id:assignmentResult.data.id, question_id:question.id, question_snapshot:questionSnapshot(question), position:index}));
  const questionResult = await state.client.from("assignment_questions").insert(rows);
  if (questionResult.error) { await state.client.from("assignments").delete().eq("id", assignmentResult.data.id); toast(questionResult.error.message); return; }
  state.selectedQuestionIds.clear();
  $("assignmentTitle").value = "";
  $("assignmentInstructions").value = "";
  toast(`已将 ${selectedQuestions.length} 道题目发送给 ${student?.display_name || "学生"}。`);
  await loadTeacherData();
}

async function toggleFeedbackRecording() {
  const button = $("teacherVoiceBtn");
  if (state.feedbackRecorder?.state === "recording") { state.feedbackRecorder.stop(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast("当前浏览器不支持语音录制。"); return; }
  try {
    state.feedbackStream = await navigator.mediaDevices.getUserMedia({audio:true});
    state.feedbackChunks = [];
    state.feedbackSeconds = 0;
    state.feedbackRecorder = new MediaRecorder(state.feedbackStream);
    state.feedbackRecorder.ondataavailable = event => { if (event.data.size) state.feedbackChunks.push(event.data); };
    state.feedbackRecorder.onstop = () => { state.feedbackStream.getTracks().forEach(track => track.stop()); state.feedbackVoiceBlob = new Blob(state.feedbackChunks, {type:state.feedbackRecorder.mimeType || "audio/webm"}); state.feedbackVoiceUrl = URL.createObjectURL(state.feedbackVoiceBlob); clearInterval(state.feedbackTimer); $("feedbackVoicePreview").innerHTML = `<audio controls src="${state.feedbackVoiceUrl}"></audio>`; button.textContent = "● 重新录制语音意见"; };
    state.feedbackRecorder.start();
    state.feedbackTimer = setInterval(() => { state.feedbackSeconds += 1; button.textContent = `■ 停止录制 ${formatDuration(state.feedbackSeconds)}`; }, 1000);
    button.textContent = "■ 停止录制 0:00";
  } catch { toast("无法访问麦克风，请检查浏览器权限。"); }
}

async function sendFeedback() {
  const submission = state.submissions.find(item => item.id === state.selectedSubmissionId);
  if (!submission) return;
  const text = $("teacherFeedbackText").value.trim();
  if (!text) { toast("请先写下文字反馈。"); return; }
  let voicePath = submission.feedback?.voice_path || null;
  if (state.feedbackVoiceBlob) {
    voicePath = `${state.profile.id}/feedback/${crypto.randomUUID()}.webm`;
    const upload = await state.client.storage.from(mediaBucket).upload(voicePath, state.feedbackVoiceBlob, {contentType:state.feedbackVoiceBlob.type || "audio/webm"});
    if (upload.error) { toast(upload.error.message); return; }
  }
  const result = await state.client.from("feedbacks").upsert({submission_id:submission.id, teacher_id:state.profile.id, fluency:Number($("scoreFluency").value), vocabulary:Number($("scoreVocabulary").value), grammar:Number($("scoreGrammar").value), pronunciation:Number($("scorePronunciation").value), feedback_text:text, voice_path:voicePath}, {onConflict:"submission_id"});
  if (result.error) { toast(result.error.message); return; }
  state.feedbackVoiceBlob = null;
  state.feedbackVoiceUrl = "";
  toast("反馈已发送给学生。");
  await loadTeacherData();
}

async function signOut() {
  if (state.client) await state.client.auth.signOut();
  state.session = null;
  state.profile = null;
  showOnly("auth");
}

function bindEvents() {
  if ($("signInForm")) $("signInForm").addEventListener("submit", signIn);
  if ($("signUpForm")) $("signUpForm").addEventListener("submit", signUp);
  document.querySelectorAll("[data-logout]").forEach(button => button.addEventListener("click", signOut));
  if ($("studentRefreshBtn")) $("studentRefreshBtn").addEventListener("click", loadStudentData);
  if ($("teacherRefreshBtn")) $("teacherRefreshBtn").addEventListener("click", loadTeacherData);
  document.querySelectorAll("[data-student-mode]").forEach(button => button.addEventListener("click", () => setStudentMode(button.dataset.studentMode)));
  if ($("studentAssignmentSelect")) $("studentAssignmentSelect").addEventListener("change", event => { state.selectedAssignmentId = event.target.value; renderStudentAssignment(); });
  if ($("studentRecordBtn")) $("studentRecordBtn").addEventListener("click", toggleStudentRecording);
  if ($("studentSubmitBtn")) $("studentSubmitBtn").addEventListener("click", submitStudentRecording);
  if ($("questionForm")) $("questionForm").addEventListener("submit", saveQuestion);
  if ($("questionResetBtn")) $("questionResetBtn").addEventListener("click", resetQuestionForm);
  if ($("questionSearch")) $("questionSearch").addEventListener("input", renderTeacherQuestions);
  if ($("teacherQuestionList")) $("teacherQuestionList").addEventListener("click", event => { const edit = event.target.closest("[data-question-edit]"); const remove = event.target.closest("[data-question-delete]"); if (edit) editQuestion(edit.dataset.questionEdit); if (remove) deleteQuestion(remove.dataset.questionDelete); });
  if ($("wordImportBtn")) $("wordImportBtn").addEventListener("click", importQuestions);
  if ($("assignmentQuestionSearch")) $("assignmentQuestionSearch").addEventListener("input", renderAssignmentPicker);
  if ($("assignmentQuestionPicker")) $("assignmentQuestionPicker").addEventListener("change", event => { const input = event.target.closest("[data-assignment-question]"); if (!input) return; if (input.checked) state.selectedQuestionIds.add(input.dataset.assignmentQuestion); else state.selectedQuestionIds.delete(input.dataset.assignmentQuestion); renderAssignmentPicker(); });
  if ($("assignmentForm")) $("assignmentForm").addEventListener("submit", createAssignment);
  if ($("teacherSubmissionList")) $("teacherSubmissionList").addEventListener("click", event => { const row = event.target.closest("[data-submission-id]"); if (!row) return; state.selectedSubmissionId = row.dataset.submissionId; state.feedbackVoiceBlob = null; state.feedbackVoiceUrl = ""; renderTeacherSubmissions(); });
  if ($("teacherReviewPanel")) $("teacherReviewPanel").addEventListener("click", event => { if (event.target.id === "teacherVoiceBtn") toggleFeedbackRecording(); if (event.target.id === "teacherSendFeedback") sendFeedback(); });
  if ($("adminRefreshBtn")) $("adminRefreshBtn").addEventListener("click", loadAdminData);
  if ($("adminInviteForm")) $("adminInviteForm").addEventListener("submit", saveTeacherInvite);
  if ($("adminCreateUserForm")) $("adminCreateUserForm").addEventListener("submit", createManagedUser);
  if ($("adminUserSearch")) $("adminUserSearch").addEventListener("input", renderAdminUsers);
  if ($("adminUserList")) $("adminUserList").addEventListener("click", event => { const button = event.target.closest("[data-admin-user-delete]"); if (button) deleteManagedUser(button.dataset.adminUserDelete); });
  document.querySelectorAll("[data-registration-role]").forEach(button => button.addEventListener("click", () => setRegistrationRole(button.dataset.registrationRole)));
}

async function init() {
  bindEvents();
  if (entryRole) {
    if ($("signUpRole")) {
      setRegistrationRole(entryRole);
      document.querySelectorAll("[data-registration-role]").forEach(button => { button.disabled = true; });
    }
    document.title = `IELTS Speaking Studio · ${{admin:"管理员", teacher:"教师", student:"学生"}[entryRole]}端`;
  } else if ($("signUpRole")) {
    setRegistrationRole($("signUpRole").value);
  }
  if (!config.url || !config.anonKey || !supabaseFactory?.createClient) {
    if ($("connectionBanner")) {
      $("connectionBanner").textContent = "请先配置 Supabase 项目 URL 和 anon key；当前页面仅显示设计稿。";
      $("connectionBanner").classList.remove("hidden");
    }
    return;
  }
  state.client = supabaseFactory.createClient(config.url, config.anonKey);
  const sessionResult = await state.client.auth.getSession();
  if (sessionResult.data.session) { state.session = sessionResult.data.session; await enterWorkspace(); }
  state.client.auth.onAuthStateChange(async (_event, session) => { if (!session) { if (!$("registrationPage")) showOnly("auth"); return; } state.session = session; await enterWorkspace(); });
}

init();
