# Liara Agentic DevOps & SRE — Product Brief

## What we want to build

We want to build an agentic technical colleague for people who run applications on Liara: something that can understand a project, deploy it, look after it, investigate problems, and take care of much of the operational work around it.

Liara already provides the underlying deployment and infrastructure capabilities. Our opportunity is to make those capabilities accessible through an assistant that understands what the user is trying to accomplish and can carry the work through to a useful result.

The ambition is broad. We are thinking about the application's operational life, from the first deployment to ongoing changes and reliability, across a range of projects. A few examples can make a good demo, but the product idea goes beyond a handful of predefined stacks or errors.

Two assumptions shape the project. Capable coding agents can help us build substantial functionality quickly. At the same time, the AI operating inside the finished product needs to be economical. We can be ambitious about what we build while being deliberate about when the product actually needs model reasoning.

This brief gives an agentic coder the product context, working ideas, and reasoning behind them. The architecture, detailed behavior, and implementation plan are for the coder to develop.

## The original Liara challenge

The complete user-supplied challenge follows in Persian. The introductory video mentioned in it has not yet been provided.

<!-- BEGIN ORIGINAL LIARA CHALLENGE -->

```text
قبل از شروع پیاده‌سازی، ابتدا ویدئوی معرفی چالش را به‌طور کامل مشاهده کنید. در این ویدئو، مسئله، نیازمندی‌ها و نحوه انجام چالش توضیح داده شده است.

قابلیت‌های مورد انتظار
راه‌اندازی اولیه و اولین دیپلوی (Initial Setup & Deployment)
راهنمایی کاربر برای انتخاب روش مناسب استقرار و راه‌اندازی اولیه‌ی وب‌سایت.
بررسی نیازمندی‌های پروژه و پیشنهاد زیرساخت و پلن مناسب لیارا متناسب با نوع پروژه و منابع موردنیاز.
کمک به انجام مراحل اولیه‌ی راه‌اندازی، پیکربندی و دیپلوی.
راهنمایی برای تنظیم دامنه و انجام مراحل موردنیاز در پنل ثبت دامنه، مانند ایرنیک، در صورت نیاز.
ساده‌سازی فرایند راه‌اندازی تا حدی که کاربر فقط مراحل ضروری و خارج از دسترس دستیار را انجام دهد.
مدیریت دیپلوی و عملیات زیرساخت (Deployment & Operations)
کمک به انتشار نسخه‌های جدید وب‌سایت.
انجام یا راهنمایی فرایندهای پیکربندی و مدیریت سرویس از طریق APIهای لیارا.
بررسی وضعیت سرویس و شناسایی خطاهای احتمالی در فرایند دیپلوی.
خودکارسازی عملیات تکراری و کاهش نیاز به انجام دستی مراحل فنی.
پایش و نگهداری (Monitoring & Maintenance)
بررسی وضعیت سلامت سرویس و منابع مصرفی، از جمله CPU و RAM، در صورت دسترسی به داده‌های مربوطه.
دریافت و تحلیل لاگ‌های مرتبط با سرویس.
کمک به بررسی مشکلاتی مانند کندشدن وب‌سایت، اختلال در عملکرد یا افزایش مصرف منابع.
ارائه‌ی پیشنهاد برای بهبود عملکرد و پایداری سرویس.
امکان انجام اقدامات اصلاحی یا راهنمایی کاربر برای رفع مشکل.
عیب‌یابی هوشمند (Intelligent Troubleshooting)
در صورت بروز خطا، برای مثال خطای HTTP 500، دستیار باید بتواند:

اطلاعات مرتبط با خطا را از منابع در دسترس جمع‌آوری کند.
لاگ‌ها، وضعیت سرویس و داده‌های منابع مصرفی را بررسی کند.
علت‌های احتمالی مشکل را شناسایی و اولویت‌بندی کند.
راهکار مناسب برای رفع مشکل ارائه دهد.
در صورت داشتن مجوز، اقدام اصلاحی انجام دهد و نتیجه را بررسی کند.
مثال:

اگر وب‌سایت کند شده باشد، دستیار می‌تواند با بررسی شواهد موجود مشخص کند که آیا افزایش مصرف RAM، محدودیت CPU، خطاهای برنامه یا عامل دیگری محتمل است؛ سپس راهکار مناسب را پیشنهاد دهد.

تعامل امن با کاربر (Human-in-the-Loop)
در عملیات حساس یا دارای پیامدهای مهم، دستیار باید پیش از اجرا از کاربر تأیید بگیرد. این عملیات می‌تواند شامل تغییرات پرریسک در تنظیمات، ری‌استارت سرویس یا تغییر پلن و منابع باشد.

راهکار باید بین عملیات کم‌ریسک قابل‌اجرا به‌صورت خودکار و عملیات حساس نیازمند تأیید کاربر تمایز قائل شود.

همچنین، نتیجه‌ی عملیات و خطاهای احتمالی باید برای کاربر قابل‌مشاهده باشد.

محدودیت‌های فنی و ابزارهای در دسترس
موضوع	توضیحات
APIهای لیارا	استفاده از APIهای لیارا برای دریافت اطلاعات موردنیاز و انجام عملیات زیرساختی.
رویکرد پیاده‌سازی	امکان استفاده از رویکردهای مختلف پیاده‌سازی، از جمله AI Agent، MCP یا ترکیبی از آن‌ها.
رابط کاربری	امکان طراحی رابط کاربری اختصاصی، رابط گفت‌وگومحور، ابزار خط فرمان یا سایر روش‌های تعامل.
انتخاب معماری	انتخاب معماری، ابزارها و نحوه‌ی پیاده‌سازی بر عهده‌ی شرکت‌کنندگان است.
محدودیت دسترسی به API	استفاده از APIها باید بر اساس قابلیت‌های واقعا در دسترس لیارا انجام شود و در مواردی که اطلاعات یا عملیات خاصی از طریق API قابل‌دسترسی نیست، راهکار باید محدودیت را به‌روشنی به کاربر اعلام کند.
نکات و الزامات طراحی محصول
تجربه‌ی کاربری (UX)
یکی از مهم‌ترین معیارهای این چالش، سادگی و سهولت استفاده برای کاربر نهایی است.

صرفا پیاده‌سازی قابلیت‌های فنی کافی نیست؛ راهکار باید بتواند عملیات پیچیده‌ی زیرساختی را به تجربه‌ای ساده، قابل‌فهم و قابل‌اعتماد تبدیل کند.

انتظار می‌رود کاربر بتواند:

درخواست خود را با حداقل دانش فنی مطرح کند.
وضعیت عملیات را بفهمد.
پیشنهادهای دستیار را ارزیابی کند.
در صورت نیاز، با تأیید خود اجازه‌ی اجرای عملیات را بدهد.
خروجی مورد انتظار
به انتخاب شرکت کننده بستگی دارد: agent یا mcp یا ...

چشم‌انداز نهایی
چشم‌انداز این چالش، ساخت دستیار هوشمندی است که بتواند نقش یک همکار فنی برای صاحبان وب‌سایت را ایفا کند؛ از اولین دیپلوی و انتخاب منابع مناسب تا پایش مستمر، تشخیص مشکلات و کمک به حفظ پایداری سرویس.

هدف نهایی این است که کاربر به‌جای درگیرشدن با پیچیدگی‌های زیرساخت، بر توسعه و بهبود محصول خود تمرکز کند.

موارد تحویلی
خروجی و مستندات موردنیاز
شرکت‌کنندگان باید یک نمونه‌ی اولیه‌ی قابل‌اجرا (MVP) ارائه دهند که بخش مشخصی از چرخه‌ی راه‌اندازی، دیپلوی یا نگهداری وب‌سایت را پوشش دهد.

نمونه‌ی اولیه باید علاوه بر نمایش قابلیت‌های فنی، یک سناریوی واقعی را از درخواست کاربر تا انجام عملیات یا تشخیص مشکل به نمایش بگذارد.

علاوه بر آن، یک داکیومنت md تهیه کنید و آن را در گیت‌هاب ذخیره کنید. این داکیومنت باید شامل موارد زیر باشد:

مستندات کوتاه معماری.
نحوه‌ی اتصال به APIهای لیارا.
محدودیت‌های راهکار.
نحوه‌ی تعامل کاربر با سیستم.
ویدئوی دمو (الزامی)
ارسال ویدئوی دمو از پروژه الزامی است.
ویدئو باید حدود ۵ دقیقه باشد و در آن عملکرد پروژه نمایش داده شده و توضیح داده شود.
در صورت عدم ارسال ویدئوی دمو، اثر از داوری حذف می‌شود.
کیفیت ویدئو نیز در امتیاز کلی اثر تأثیرگذار است.
در ویدئو خروجی کار را نشان دهید و نیازی به نمایش سورس کد نیست. عملکرد، تأثیر، خروجی و موارد قابل نمایش مهم است.
کار خود را کامل پرزنت کنید. این موضوع خیلی مهم است.
اگر امکان صحبت کردن ندارید، می‌توانید فقط از خروجی کار ویدئوی بی‌صدا بگیرید، اما امتیاز کمتری می‌گیرید. این حالت بهتر از آن است که اصلا امتیازی نگیرید.
نیاز به ادیت خاصی نیست.
معیارهای داوری
پروژه‌ها بر اساس معیارهای زیر ارزیابی خواهند شد:

عملکرد فنی و یکپارچه‌سازی با لیارا: ۱۰۰ امتیاز
اتصال به APIهای لیارا
راه‌اندازی و دیپلوی
مدیریت سرویس
اجرای موفق عملیات زیرساختی
هوشمندی و توانایی حل مسئله: ۱۰۰ امتیاز
تحلیل لاگ‌ها
تشخیص خطا
شناسایی علت‌های احتمالی مشکلات
ارائه راهکار
بررسی نتیجه اقدامات اصلاحی
تجربه کاربری: ۵۰ امتیاز
سادگی تعامل
قابل‌فهم بودن پیشنهادها
نمایش وضعیت عملیات
مدیریت تأیید کاربر برای اقدامات حساس
پایداری، نگهداری و امنیت عملیات: ۵۰ امتیاز
پایش سلامت سرویس و منابع
خودکارسازی عملیات تکراری
مدیریت امن اقدامات حساس
اعلام محدودیت‌های API
جدول بارم‌بندی
ردیف	معیار ارزیابی	موارد مورد ارزیابی	امتیاز
۱	عملکرد فنی و یکپارچه‌سازی با لیارا	اتصال به APIهای لیارا، راه‌اندازی و دیپلوی، مدیریت سرویس و اجرای موفق عملیات زیرساختی	۱۰۰
۲	هوشمندی و توانایی حل مسئله	تحلیل لاگ‌ها، تشخیص خطا، شناسایی علت‌های احتمالی مشکلات، ارائه راهکار و بررسی نتیجه اقدامات اصلاحی	۱۰۰
۳	تجربه کاربری (UX)	سادگی تعامل، قابل‌فهم بودن پیشنهادها، نمایش وضعیت عملیات و مدیریت تأیید کاربر برای اقدامات حساس	۵۰
۴	پایداری، نگهداری و امنیت عملیات	پایش سلامت سرویس و منابع، خودکارسازی عملیات تکراری، مدیریت امن اقدامات حساس و اعلام محدودیت‌های API	۵۰
مجموع		۳۰۰
```

<!-- END ORIGINAL LIARA CHALLENGE -->

## How people would use it

A user might begin with a repository and say, “Deploy this project on Liara.” The assistant would examine the project, understand how it runs, notice its dependencies, and work out what needs to exist for it to function. That might be a single web application, or a frontend, backend, database, and worker that belong together.

It would help choose an appropriate deployment approach and suitable Liara resources, explaining the important tradeoffs in language the user understands. It would handle the setup and deployment work available through Liara, ask for genuinely missing information, and bring the application online. Domain configuration belongs in this experience too: when a step has to happen in a registrar's panel, such as IRNIC, the assistant should guide the user through that step and continue afterward.

An existing deployment is another natural starting point. The assistant can get to know the applications already running, connect that picture to the source code where available, and become useful without making the user start over.

The relationship continues after deployment. The user can ask for a new release, a configuration change, an explanation of rising resource consumption, or help with a failing endpoint. The assistant has the project's context and can perform real operations through the available integrations.

For example, “The website became slow after the last update” should lead to an investigation using relevant logs, resource measurements, deployment history, dependencies, and code. The assistant can follow the evidence, consider possible causes, and prepare or carry out an appropriate correction. Code-aware debugging is part of the intended capability; the product should be able to reason about application problems as well as infrastructure settings.

The important experience is continuity: the assistant understands the request, does the accessible work, brings the user into decisions when necessary, and checks whether the intended result was achieved. If it cannot complete something, it explains the actual obstacle and helps move the work forward.

## A project picture that agents can rely on

One of the central ideas is to maintain a living description of each project. Before investigating a problem, an agent should already have a useful picture of what exists and how the components connect.

For example, it might know that a Next.js application serves a particular domain, talks to a PostgreSQL database, and depends on a separate worker. It can also know which versions are deployed, what resources are assigned, and which configuration connects the services. This information could be represented as a graph, structured records, a readable document, or a combination.

The purpose is practical: reduce repeated discovery, improve reasoning about dependencies, and avoid filling the context window with irrelevant exploration. A debugging agent receives the part of the project picture relevant to its task, then investigates further where needed.

The picture should stay connected to reality as releases and configuration change. There is a useful distinction between what the repository suggests, what the user says is intended, and what the running system actually exposes. Remembering where information came from and when it was observed helps the assistant avoid acting on stale assumptions.

The user's original example included containers and servers. That level of detail is useful when available, but Liara may hide parts of the underlying infrastructure. The project picture should reflect what we can actually know. Choosing the representation and deciding how it stays fresh are design opportunities for the coding agent; a dedicated graph database is not assumed.

## Several agents, with intelligence used where it matters

The intended direction is a multi-agent system with complementary responsibilities and different models where that makes sense. Coordination, deployment, debugging, optimization, and maintaining useful project knowledge are examples of responsibilities that could benefit from different instructions and tools.

This does not imply a fixed organization chart or that every request needs a team of agents. The coding agent should decide where specialization improves the result and where a simpler path is sufficient.

The cost benefit comes from giving a task the right amount of capability and context. Routine work can use economical models; a difficult diagnosis or code change may justify a stronger one. An agent investigating a database issue usually needs the relevant application code, database context, and selected evidence, rather than the complete history of every service.

The same principle applies to what agents return to one another. Useful findings and references to evidence are often more valuable than copying entire intermediate transcripts into the coordinator's context.

Multi-agent systems are not automatically cheaper. Delegation, repeated investigation, and unnecessary model calls can add cost. We want to discover a practical balance through real tasks, with visibility into where inference is being spent. Model choices, role boundaries, and escalation behavior remain part of the implementation design.

## Work that continues after the conversation

The assistant should be able to arrange future work for itself. This is an important part of making it an ongoing operational colleague.

### Schedules

A user could ask the assistant to check an application's health periodically, review resource usage every morning, or perform an appropriate recurring maintenance task. The assistant could also suggest a useful schedule while working on the project.

These jobs should become real background work that the user can understand, inspect, change, and stop. The interesting part is letting the agent translate an operational intention into something the system continues doing after the chat ends.

There is no reason for an LLM to perform every routine poll. The runtime can collect measurements and perform simple checks, involving an agent when interpretation or a decision is needed. A scheduled report that requires analysis is a different workload from checking whether a service is reachable.

### Hooks and conditions

The agent should also be able to define conditions that bring it back into an investigation when something happens.

The original idea was: “If backend.log contains error: 400, run a debugging session with that line and additional context.” That captures the intended behavior well: the agent can arrange to be called with useful evidence when a relevant event occurs.

The implementation needs to map such intentions to signals actually available from Liara or another connected source. A named log file might not be directly accessible, and a single HTTP 400 might be normal. The assistant can help turn the user's concern into a meaningful condition.

Events should be grouped into coherent work. An error burst should not launch a new agent for every log line, and a continuing incident should accumulate useful evidence without flooding the main conversation. How quickly the agent reacts will depend on whether the integration offers events, streams, or polling.

Schedules and hooks can initiate investigation; any sensitive corrective action still goes through the appropriate user approval.

## Getting more useful and cheaper through experience

The product should retain what it learns about an application and reuse work it has already figured out. The owner's idea combines memory, Skills, and moving suitable tasks out of the agent loop.

These serve different purposes. The project picture describes what exists now. Memory preserves useful findings, decisions, and preferences. A Skill explains how to perform a kind of work. A script or workflow performs steps whose behavior is already sufficiently understood.

A `MEMORY.md`-style overview could help an agent get oriented, with detailed information available when relevant. The aim is useful continuity, so we should avoid turning memory into an enormous document inserted into every prompt. Context management, selective retrieval, and loading relevant Skills are part of making economical models effective.

Knowledge can belong to an application, a project, a group of applications, or an organization. For example, several applications in the same company may share a deployment convention or recurring operational procedure. The product can benefit from that shared knowledge while respecting which information belongs to which customer or project.

When the assistant solves a recurring problem, it can preserve a reusable method. When the steps are predictable enough, it can turn them into a script or workflow that the runtime executes later. A routine check might then consume no LLM calls unless it encounters an unexpected result.

Reuse still needs judgment. A similar error message does not always have the same cause, and a procedure that worked before may no longer fit the application. Generated procedures should be checked before being trusted, and their permissions remain those of the work they perform. Credentials do not belong in memory or shared Skills.

The economic goal is that preparing a solution once makes later repetitions cheaper. The coder should work out how to identify suitable work, how to validate reuse, and how to make the benefit visible without adding an expensive learning process to every trivial action.

## Bringing existing optimization knowledge into the product

Liara explicitly asks for suggestions that improve performance and reliability. We should take advantage of useful knowledge that already exists instead of expecting a small model to rediscover every best practice.

Public Skills are a promising starting point. Examples include [Vercel's React/Next.js performance guidance](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/SKILL.md), [Supabase's PostgreSQL Skills](https://supabase.com/docs/guides/ai-tools/ai-skills), and [Addy Osmani's web-performance Skill](https://github.com/addyosmani/web-quality-skills/blob/main/skills/performance/SKILL.md). These are examples of reusable knowledge, not a list of the only stacks we want to support.

The assistant can select guidance relevant to the detected project and combine it with available evidence. A recommendation is much more useful when it explains why it applies to this application, what might improve, and what remains uncertain.

Some advice contains assumptions about a particular hosting platform or environment. It should be adapted thoughtfully to Liara. Likewise, a suggestion to increase resources should be grounded in the situation rather than become the default answer to every slowdown.

The coding agent has room to explore how Skills are discovered, curated, organized, and used, including how general guidance and organization-specific experience complement one another.

## A simple experience with appropriate control

We want the product to work for someone with little infrastructure knowledge and for a developer who wants to understand the details. The proposed Auto and Ask modes are ways to accommodate those preferences.

**Auto mode** should take initiative, choose sensible defaults, and avoid unnecessary interruptions. The user describes a goal and the assistant does the work it can do, with concise progress updates and questions when a real decision or missing input matters.

**Ask or Guided mode** should expose more of the decisions, evidence, alternatives, and tradeoffs. A technical user can participate more closely without having to perform every operation manually. The eventual name can be chosen to make this clear.

The useful distinction is participation, not authority. Auto does not mean unrestricted permission, and Guided does not have to mean read-only. A restart, a resource-plan change, or a significant configuration change still needs the approval called for by the challenge.

Approval should be concrete and understandable. For example, the assistant explains which service it wants to restart, why that may help, and the expected disruption. For a resource change, it also explains the cost implication when known. The execution system enforces the decision, rather than relying only on a sentence in the model's prompt.

Outside these decisions, the interface should make it easy to see what the assistant is doing and what it achieved. Details can be available without turning the normal experience into a wall of logs. The coding agent should have room to design the interaction.

### Voice input

The owner's proposed addition is Persian speech-to-text using Shenava, making it easier to describe a request aloud.

This can be a simple input capability alongside typing. The user sees the transcript and can correct it, especially when it contains mixed Persian and English technical terms, domains, or service names. The exact Shenava variant and deployment approach are open to evaluation; the [official Rizeh export](https://huggingface.co/Reza2kn/Shenava-Rizeh-v1.0-sherpa-onnx) is one concrete starting point.

Voice enters the same conversation and operational process as text. The important benefit is easier communication without creating a separate set of execution rules.

## Architecture directions worth exploring

The architecture discussion that resonated was the combination of agent reasoning, focused project context, durable coordination, controlled tools, and ordinary runtime execution. The intelligence can decide what to investigate or propose, while the surrounding system handles work such as scheduling, collecting signals, retaining progress, and enforcing approvals.

That separation matters for cost and reliability. A task may wait for a deployment, an event, or user input without an active model loop. The system should be able to continue a long-running task without losing the project context or accidentally repeating a consequential operation.

### LangGraph and Deep Agents

[LangGraph](https://docs.langchain.com/oss/python/langgraph/interrupts) is a promising candidate for coordinating stateful work and pauses for human input. [Deep Agents](https://docs.langchain.com/oss/python/deepagents/overview) is a promising harness for investigation, tool use, context management, Skills, and subagents.

Here, “harness” means the environment around the model that helps it work: its tools, context handling, delegation, and execution behavior. Choosing a capable harness does not inherently require an expensive model.

Deep Agents already builds on LangGraph, so they should be considered together rather than treated as unrelated layers that both need to be reinvented. The coding agent should assess their fit with the desired models, the workflows, and the project's deployment environment.

### Hermes and other choices

[Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron) is another relevant option to examine, including its approaches to scheduled work and script execution without waking an agent. Its [single-tenant trust assumptions](https://github.com/NousResearch/hermes-agent/blob/main/SECURITY.md) matter if it is adapted into a service used by multiple customers.

These names express the directions we discussed, not a decision to use every framework. A different combination is welcome if it serves the product better and the reasoning is clear.

MCP can also be useful for exposing capabilities to agents. Its role is an integration interface; permission checks and approval enforcement still belong in the actual execution system.

### Working with Liara

The product should operate through Liara's real capabilities. The [official API documentation](https://developers.liara.ir/llms.txt) is the starting point for understanding deployment, application operations, logs, resource reports, databases, and DNS.

Documentation is not the same as having tested every operation in our account. The coder will need to investigate the interfaces used by the product and work out where a user handoff is necessary. An unavailable metric should remain an unknown, and an operation outside the available interfaces should be explained honestly.

Model-provider compatibility also deserves practical validation. For example, an OpenAI-compatible model endpoint does not automatically support every provider-specific agent SDK. This is the sort of technical choice the implementation plan should resolve.

## What the agentic coder should do with this brief

Use this material to understand the product we are trying to build and develop a strong implementation plan. Choose the architecture, interface, storage, model strategy, and sequencing that make the ideas work together. Improve on the suggested approaches where there is a good reason, and make important assumptions visible.

Keep the original ambition in view: broad operational usefulness, an agent that knows the project, work that continues in the background, and increasing reuse that keeps runtime cost reasonable. The real Liara integration, understandable approvals, and verification of useful outcomes are central to the experience.

The challenge text already contains the submission and video expectations. Plan a clear demonstration of the product while giving yourself room to design the system beyond what can fit in five minutes.

