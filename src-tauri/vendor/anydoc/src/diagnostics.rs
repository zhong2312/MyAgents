use crate::Diagnostic;
use std::cell::RefCell;

thread_local! {
    static DIAGNOSTICS: RefCell<Vec<Diagnostic>> = const { RefCell::new(Vec::new()) };
}

pub(crate) fn clear() {
    DIAGNOSTICS.with(|diagnostics| diagnostics.borrow_mut().clear());
}

pub(crate) fn emit(code: &str, location: Option<String>, message: String) {
    DIAGNOSTICS.with(|diagnostics| {
        let mut diagnostics = diagnostics.borrow_mut();
        if diagnostics.len() >= 100 {
            return;
        }
        let mut message = message.replace(['\r', '\n'], " ");
        message.truncate(500);
        diagnostics.push(Diagnostic {
            code: code.to_string(),
            location,
            message,
        });
    });
}

pub(crate) fn take() -> Vec<Diagnostic> {
    DIAGNOSTICS.with(|diagnostics| std::mem::take(&mut *diagnostics.borrow_mut()))
}
