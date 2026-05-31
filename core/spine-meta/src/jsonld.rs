use serde_json::Value;
use spine_api::{AgentLink, AuthorityLink, BibliographicGraph, Instance, Work};

pub fn parse_loc_jsonld(json: &Value) -> Option<BibliographicGraph> {
    let arr = json.as_array()?;

    let mut work_node = None;
    let mut instance_node = None;

    // 1. Find Work and Instance Nodes
    for node in arr {
        if let Some(types) = node.get("@type").and_then(|t| t.as_array()) {
            for t in types {
                if t.as_str() == Some("http://id.loc.gov/ontologies/bibframe/Work") {
                    work_node = Some(node);
                } else if t.as_str() == Some("http://id.loc.gov/ontologies/bibframe/Instance") {
                    instance_node = Some(node);
                }
            }
        }
    }

    let work = work_node?;
    let work_uri = work.get("@id").and_then(|i| i.as_str())?.to_string();
    
    let instance = instance_node?;
    let instance_uri = instance.get("@id").and_then(|i| i.as_str())?.to_string();

    // Helper to resolve nodes by @id
    let resolve = |id: &str| -> Option<&Value> {
        arr.iter().find(|n| n.get("@id").and_then(|i| i.as_str()) == Some(id))
    };

    // Helper to get first @value from a property
    let get_val = |node: &Value, prop: &str| -> Option<String> {
        node.get(prop)?
            .as_array()?
            .get(0)?
            .get("@value")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };

    // Helper to get first @id from a property
    let get_id_ref = |node: &Value, prop: &str| -> Option<String> {
        node.get(prop)?
            .as_array()?
            .get(0)?
            .get("@id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };

    // Extract Origin Date from Work (or fallback to instance ProvisionActivity)
    let mut origin_date = get_val(work, "http://id.loc.gov/ontologies/bibframe/originDate");
    
    if origin_date.is_none() {
        if let Some(prov_refs) = instance.get("http://id.loc.gov/ontologies/bibframe/provisionActivity").and_then(|p| p.as_array()) {
            for pref in prov_refs {
                if let Some(p_id) = pref.get("@id").and_then(|i| i.as_str()) {
                    if let Some(prov_node) = resolve(p_id) {
                        if let Some(d) = get_val(prov_node, "http://id.loc.gov/ontologies/bibframe/date") {
                            origin_date = Some(d);
                            break;
                        }
                    }
                }
            }
        }
    }

    // Extract Creators
    let mut creators = Vec::new();
    if let Some(contribs) = work.get("http://id.loc.gov/ontologies/bibframe/contribution").and_then(|c| c.as_array()) {
        for contrib_ref in contribs {
            if let Some(cid) = contrib_ref.get("@id").and_then(|i| i.as_str()) {
                if let Some(contrib_node) = resolve(cid) {
                    if let Some(agent_id) = get_id_ref(contrib_node, "http://id.loc.gov/ontologies/bibframe/agent") {
                        if let Some(agent_node) = resolve(&agent_id) {
                            if let Some(name) = get_val(agent_node, "http://www.w3.org/2000/01/rdf-schema#label") {
                                creators.push(AgentLink {
                                    uri: agent_id,
                                    name,
                                    role: "creator".to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // Extract Title
    let mut title = None;
    if let Some(title_refs) = work.get("http://id.loc.gov/ontologies/bibframe/title").and_then(|t| t.as_array()) {
        for t_ref in title_refs {
            if let Some(tid) = t_ref.get("@id").and_then(|i| i.as_str()) {
                if let Some(tnode) = resolve(tid) {
                    if let Some(main_title) = get_val(tnode, "http://id.loc.gov/ontologies/bibframe/mainTitle") {
                        let mut full_title = main_title.trim().to_string();
                        // Also append subtitle if present
                        if let Some(subtitle) = get_val(tnode, "http://id.loc.gov/ontologies/bibframe/subtitle") {
                            full_title = format!("{}: {}", full_title, subtitle.trim());
                        }
                        title = Some(full_title);
                        break;
                    }
                }
            } else if let Some(main_title) = get_val(t_ref, "http://id.loc.gov/ontologies/bibframe/mainTitle") {
                // Inline title node
                title = Some(main_title.trim().to_string());
                break;
            }
        }
    }

    // Extract Identifiers
    let mut lccn = None;
    if let Some(idents) = work.get("http://id.loc.gov/ontologies/bibframe/identifiedBy").and_then(|i| i.as_array()) {
        for ident_ref in idents {
            if let Some(iid) = ident_ref.get("@id").and_then(|i| i.as_str()) {
                if let Some(inode) = resolve(iid) {
                    if let Some(types) = inode.get("@type").and_then(|t| t.as_array()) {
                        if types.iter().any(|t| t.as_str() == Some("http://id.loc.gov/ontologies/bibframe/Lccn")) {
                            if let Some(val) = get_val(inode, "http://www.w3.org/1999/02/22-rdf-syntax-ns#value") {
                                lccn = Some(val.trim().to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    let mut isbn = None;
    let mut oclc = None;
    if let Some(idents) = instance.get("http://id.loc.gov/ontologies/bibframe/identifiedBy").and_then(|i| i.as_array()) {
        for ident_ref in idents {
            if let Some(iid) = ident_ref.get("@id").and_then(|i| i.as_str()) {
                if let Some(inode) = resolve(iid) {
                    if let Some(types) = inode.get("@type").and_then(|t| t.as_array()) {
                        if types.iter().any(|t| t.as_str() == Some("http://id.loc.gov/ontologies/bibframe/Isbn")) {
                            if isbn.is_none() {
                                if let Some(val) = get_val(inode, "http://www.w3.org/1999/02/22-rdf-syntax-ns#value") {
                                    isbn = Some(val.trim().to_string());
                                }
                            }
                        } else if types.iter().any(|t| t.as_str() == Some("http://id.loc.gov/ontologies/bibframe/OclcNumber")) {
                            if let Some(val) = get_val(inode, "http://www.w3.org/1999/02/22-rdf-syntax-ns#value") {
                                oclc = Some(val.trim().to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    // Extract Language
    let mut language = None;
    if let Some(lang_refs) = work.get("http://id.loc.gov/ontologies/bibframe/language").and_then(|l| l.as_array()) {
        if let Some(first_lang) = lang_refs.get(0) {
            if let Some(lid) = first_lang.get("@id").and_then(|i| i.as_str()) {
                language = Some(lid.split('/').last().unwrap_or(lid).to_string());
            }
        }
    }

    // Extract Publisher
    let mut publisher = None;
    if let Some(prov_refs) = instance.get("http://id.loc.gov/ontologies/bibframe/provisionActivity").and_then(|p| p.as_array()) {
        for pref in prov_refs {
            if let Some(p_id) = pref.get("@id").and_then(|i| i.as_str()) {
                if let Some(prov_node) = resolve(p_id) {
                    if let Some(types) = prov_node.get("@type").and_then(|t| t.as_array()) {
                        if types.iter().any(|t| t.as_str() == Some("http://id.loc.gov/ontologies/bibframe/Publication")) {
                            if let Some(agent_id) = get_id_ref(prov_node, "http://id.loc.gov/ontologies/bibframe/agent") {
                                if let Some(agent_node) = resolve(&agent_id) {
                                    if let Some(name) = get_val(agent_node, "http://www.w3.org/2000/01/rdf-schema#label") {
                                        publisher = Some(name);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Extract Subjects
    let mut subjects = Vec::new();
    if let Some(subj_refs) = work.get("http://id.loc.gov/ontologies/bibframe/subject").and_then(|s| s.as_array()) {
        for s_ref in subj_refs {
            if let Some(sid) = s_ref.get("@id").and_then(|i| i.as_str()) {
                if let Some(subj_node) = resolve(sid) {
                    if let Some(label) = get_val(subj_node, "http://www.w3.org/2000/01/rdf-schema#label") {
                        subjects.push(AuthorityLink {
                            uri: sid.to_string(),
                            label,
                            source: "LCSH".to_string(),
                        });
                    }
                }
            }
        }
    }

    // Extract DDC
    let mut ddc = None;
    if let Some(classes) = work.get("http://id.loc.gov/ontologies/bibframe/classification").and_then(|c| c.as_array()) {
        for class_ref in classes {
            if let Some(cid) = class_ref.get("@id").and_then(|i| i.as_str()) {
                if let Some(cnode) = resolve(cid) {
                    if let Some(types) = cnode.get("@type").and_then(|t| t.as_array()) {
                        if types.iter().any(|t| t.as_str() == Some("http://id.loc.gov/ontologies/bibframe/ClassificationDdc")) {
                            if let Some(val) = get_val(cnode, "http://id.loc.gov/ontologies/bibframe/classificationPortion") {
                                ddc = Some(val.trim().to_string());
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    Some(BibliographicGraph {
        work_uri: work_uri.clone(),
        instance_uri: instance_uri.clone(),
        work: Work {
            uri: work_uri,
            title,
            origin_date: origin_date.clone(),
            subjects,
            creators,
            language,
            lccn,
            ddc,
        },
        instances: vec![
            Instance {
                uri: instance_uri,
                format: "Print".to_string(),
                publication_date: origin_date,
                publisher,
                isbn,
                oclc,
            }
        ],
    })
}

