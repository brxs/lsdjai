//! Throwaway diagnostic: does midir enumerate CoreMIDI ports from a plain
//! background thread (the scanner's situation)?
use midir::MidiInput;

#[test]
fn probe_ports_from_background_thread() {
    let from_bg = std::thread::spawn(|| {
        let input = MidiInput::new("probe-bg").expect("client");
        input
            .ports()
            .iter()
            .map(|p| input.port_name(p).unwrap_or_default())
            .collect::<Vec<_>>()
    })
    .join()
    .unwrap();
    println!("background-thread ports: {from_bg:?}");

    let input = MidiInput::new("probe-test-thread").expect("client");
    let here: Vec<String> = input
        .ports()
        .iter()
        .map(|p| input.port_name(p).unwrap_or_default())
        .collect();
    println!("test-thread ports: {here:?}");
}
