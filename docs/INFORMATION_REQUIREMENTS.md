# Tactical Atlas requirements

**Long-term project objective**

> Making it easier for everyone to find the content they need, and facilitating more effective matching between content creators and consumers.

Tactical Atlas should help someone describe what they want from a game, find a shortlist worth exploring, and see why each game is there. This should work for a player who knows exactly what they need and for one who is still figuring it out. The starting scope is turn-based tactical games and party RPGs, with search in English and Simplified Chinese.

## What the site should do

1. **Understand what matters to the player.** Keep must-haves, preferences, and exclusions distinct. If someone asks for fantasy **or** science fiction, either setting is acceptable. Keep the player's wording available and let them correct how the site understood it. The same request should be treated the same way in English and Simplified Chinese. If “a long story” could mean more hours or a story that stays central throughout the game, ask one short question when the answer would change the shortlist. Otherwise show the assumption and let the player adjust it.

2. **Show what fits and what still needs checking.** Confirm a game only when the available evidence supports every must-have. A known conflict with a must-have rules it out. If a promising game has an unanswered must-have, show it as a possible option and name what needs checking. For example, “must work offline on Steam Deck” remains a requirement even if the site cannot check it. Use preferences to order suggestions. “Around 50 hours” favors estimates near 50. For a soft preference of “at least 50 hours,” shorter campaigns can earn partial credit and longer campaigns meet the target.

3. **Help the player decide what to try next.** Show a reason tied to the request and any tradeoff or uncertainty that could change the choice. Let players check the source and compare games on the same points. A relevant gameplay example can help answer questions about the experience when one is available. A good answer can lead to trying a demo, ruling a game out, or knowing exactly what to check next.

4. **Give lesser-known games a fair chance to be found.** Include them when deciding which games to research and ask the same questions of them as of familiar titles. Give equally relevant, equally supported matches the same treatment regardless of sales, review counts, or how much has been written about them. Let a developer point to evidence or suggest a correction. Review the claim before it affects search results.

5. **Preserve game information so we can check, correct and reuse it.** Keep enough of the original material and its context to revisit the information as search and other features evolve. Link searchable entries to their sources, including the location, date, and edition, platform or version when relevant. When a claim is corrected or withdrawn, update the results and explanations that relied on it. Choose how to use the source material based on what it improves for players or makes easier to maintain. Keep private notes and feedback separate from public game evidence. Personal bookmarks are a separate product decision.

6. **Make search effective at a reasonable cost.** Judge search methods by how well they understand requests and find suitable games. Compare those gains with response time and the cost of running and maintaining each method. Reuse work such as reviewed game information across searches. Browsing, manual filtering, and comparison should work when AI interpretation is unavailable, and manual edits should update the shortlist without another paid call. Keep the spending limit adjustable so it can change independently of search behavior.

7. **Keep the beta easy to change.** Keep evidence collection, interpretation, matching and presentation distinct so each can change as we learn. Adding a new searchable property should have a clear path through the data, search and explanation. New tasks should be able to use the same game information and evidence. When data formats change, handle existing records and keep prior results traceable.

Interpret each condition in the context of the whole request. Use examples to test general rules and choose priorities based on what affects player decisions. When the context supports several readings that would produce different results, surface the ambiguity and ask a focused question.

## Where we are starting

The November 2 preview already supports manual filters, exclusions, profiles, and comparison across 24 games. The main gap is that a must-have the search does not understand can get left out of the match decision. For example, a local check with fantasy and Linux support both required put nine games in the supported group because only the fantasy requirement reached the matcher. The local duration prototype shows how a preference can receive partial credit. It has estimates for four games, and each estimate leaves mandatory playtime unresolved. [November 2 release](RELEASE_2026-11-02.md) · [Search design and detailed findings](SEARCH_DISCOVERY.md)

## How we will check the requirements

Start with one clear must-have and one ambiguous preference. For each, write down what the request means, what the catalogue supports, and what the player should see. Then use 8–12 cases and 6–8 contrasting games from the existing catalogue to check the current behavior. Use examples already recorded in the project and clearly labeled test scenarios.

Compare a focused change with the current search using the same catalogue. Look for false confirmations, relevant options that were missed, and explanations that overstate the source. Set aside fresh cases before tuning, including equivalent requests in both languages and a relevant lesser-known title. Use a small example of adding a property and correcting a claim to check how easily changes carry through to the results. [Search design and storage proposal](SEARCH_DISCOVERY.md#two-layers-for-game-information)

The current pilot runs locally with existing records and prepared inputs. It can check whether the system follows these rules in the tested cases. Player usefulness and broader discovery outcomes remain open measurements.
