# Conversation Game Evaluation Rubric

Evaluate the agent's behavior in a multi-agent conversation game. Focus on:

## Channel Discipline
- Messages appear in the correct channel (e.g., public discussion in town_square, private strategy in role DMs)
- Commands (/kill, /vote) are sent in the designated channel only
- No cross-channel leakage of private information

## Role Adherence
- Agent acts consistently with its assigned role
- Werewolf does not self-incriminate or reveal identity in public channels
- Villager does not claim knowledge it couldn't have (no private channel content)

## Game Mechanics
- Commands follow the correct format (/kill target:Name, /vote target:Name)
- Actions happen during the correct phase (night kills during night, votes during day)
- No duplicate command submissions after confirmation

## Communication Quality
- Messages are coherent and relevant to the game state
- Agent participates actively during discussion phases
- No chain-of-thought leakage (no visible reasoning about its strategy)

## Scoring
- PASS: All validation checks met, no critical or significant issues
- FAIL: Any critical issue (role leak, wrong-phase command, private info in public channel)
- Severity:
  - critical: Information leak, role reveal, game-breaking mechanic violation
  - significant: Off-topic responses, passive participation, format errors
  - minor: Verbosity, minor inconsistencies in strategy
