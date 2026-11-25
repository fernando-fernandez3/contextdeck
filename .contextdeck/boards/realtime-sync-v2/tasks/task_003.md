---
id: task_003
title: Wire idea-to-video skill CLI hook to attach .mp4 explainers
column: backlog
priority: medium
assignee: human
linkedSessionIds:
  - sess_grok_research
linkedDecisionIds:
  - dec_002
tags:
  - skills
  - video
  - kokoro-tts
createdAt: '2026-11-25T23:31:58.049Z'
updatedAt: '2026-11-25T23:31:58.049Z'
---

At the end of an idea-to-video run, call `cdeck media add --type video --file out.mp4 --transcript ... --based-on dec_003`.
