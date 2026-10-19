# Changelog

Newest first, keyed by the date a change reached `main`, so anyone holding a copy can compare against the date they took it. Behaviour changes and anything that would make a reader act differently. Changes to tests, internals or wording that a running deployment cannot observe are not listed.

## 2026-10-19

The assignment brief now tells a session which run it is for, and that it is the only run to act on.

A session belongs to a (run, agent) pair, but the Manifestly credential it holds is account-wide and the assignment lookup spans every run. A session woken by a delivery about its own run could therefore find another run's steps assigned to the same agent, and nothing told it those were not its to work. That happened in our deployment: a session woken by a terminal event on its own run completed a different run's steps, overwriting the work of the session that run belonged to, after that work had been handed to a person for approval. Both sessions did the whole job and the later writer won silently.

If you hold a copy taken before this date, your brief says `find your own assignments in the run` where the only question the agent can ask spans every run. Two overlapping runs under one agent are enough to reproduce it.

The brief also now carries `session_id` on deliveries after the first, and says plainly that it has none on the first message. An agent with no identity to report has been observed generating one and then citing it as fact in a record a person acted on.
