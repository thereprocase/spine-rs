pub const MARC_SAMPLE: &str = include_str!("../data/marc/sample.xml");

// Future placeholder for ONIX, OPF, BIBFRAME samples
// pub const ONIX_SAMPLE: &str = include_str!("../data/onix/sample.xml");
// pub const OPF_SAMPLE: &str = include_str!("../data/opf/sample.opf");
// pub const BIBFRAME_SAMPLE: &str = include_str!("../data/bibframe/sample.jsonld");

pub fn get_marc_sample() -> &'static str {
    MARC_SAMPLE
}
