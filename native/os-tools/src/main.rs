use clap::{Parser, Subcommand};
use std::io::{self, Read};

#[derive(Parser)]
#[command(name = "deskagent-os-tools")]
#[command(about = "Native OS automation bridge for DeskAgent")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Return platform and capability metadata without side effects.
    Probe,
    /// Execute a desktop action from JSON stdin or --json.
    Action(JsonInput),
    /// Open an application from JSON stdin or --json.
    OpenApp(JsonInput),
    /// Open a URL from JSON stdin or --json.
    OpenUrl(JsonInput),
    /// Save a screen capture from JSON stdin or --json.
    Screenshot(JsonInput),
}

#[derive(Parser)]
struct JsonInput {
    /// Request JSON. When omitted, JSON is read from stdin.
    #[arg(long)]
    json: Option<String>,
}

fn read_request(input: JsonInput) -> Result<deskagent_os_tools::ToolRequest, String> {
    let raw = if let Some(json) = input.json {
        json
    } else {
        let mut buf = String::new();
        io::stdin()
            .read_to_string(&mut buf)
            .map_err(|error| format!("failed to read stdin: {error}"))?;
        buf
    };
    if raw.trim().is_empty() {
        return Ok(deskagent_os_tools::ToolRequest::default());
    }
    serde_json::from_str(&raw).map_err(|error| format!("invalid request JSON: {error}"))
}

fn run() -> Result<deskagent_os_tools::ToolResponse, String> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Probe => deskagent_os_tools::probe(),
        Commands::Action(input) => deskagent_os_tools::run_action(read_request(input)?),
        Commands::OpenApp(input) => deskagent_os_tools::open_app(read_request(input)?),
        Commands::OpenUrl(input) => deskagent_os_tools::open_url(read_request(input)?),
        Commands::Screenshot(input) => deskagent_os_tools::take_screenshot(read_request(input)?),
    }
}

fn main() {
    match run() {
        Ok(response) => {
            println!(
                "{}",
                serde_json::to_string(&response).expect("serializing response should not fail")
            );
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
