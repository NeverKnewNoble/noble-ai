import "dotenv/config"

export async function webSearch(query) {
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        max_results: 5
      })
    })

    const data = await response.json()

    return data.results
      ?.map(r => `
TITLE: ${r.title}
CONTENT: ${r.content}
URL: ${r.url}
`)
      .join("\n\n")

  } catch (err) {
    return "Internet search failed."
  }
}