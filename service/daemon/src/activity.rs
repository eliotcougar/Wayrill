//! Scoped observers for native work performed synchronously under lifecycle
//! ownership. Reports carry observations, never permission to replay a mutation.
use std::{cell::RefCell, rc::Rc};
use wayrill_protocol::NativeActivity;
type Observer = Rc<dyn Fn(NativeActivity)>;
thread_local! { static OBSERVERS: RefCell<Vec<Observer>> = const { RefCell::new(Vec::new()) }; }
pub fn observe<T>(observer: impl Fn(NativeActivity) + 'static, operation: impl FnOnce() -> T) -> T {
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            OBSERVERS.with(|v| {
                v.borrow_mut().pop();
            });
        }
    }
    OBSERVERS.with(|v| v.borrow_mut().push(Rc::new(observer)));
    let _guard = Guard;
    operation()
}
pub fn with_events<T>(
    events: std::sync::Arc<crate::events::Events>,
    operation: impl FnOnce() -> T,
) -> T {
    observe(
        move |a| events.publish("runtime.activity", serde_json::to_value(a).unwrap()),
        operation,
    )
}
pub fn report(activity: NativeActivity) {
    let observers = OBSERVERS.with(|v| v.borrow().clone());
    for observer in observers {
        observer(activity.clone());
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use wayrill_protocol::SharingPhase;
    #[test]
    fn nested_observation_restores_scope_including_unwind() {
        let seen = Rc::new(RefCell::new(Vec::new()));
        let outer = seen.clone();
        let tick = || {
            report(NativeActivity {
                phase: SharingPhase::WaitAdapter,
                elapsed_ms: 40001,
            })
        };
        observe(
            move |_| outer.borrow_mut().push("outer"),
            || {
                let inner = seen.clone();
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    observe(
                        move |_| inner.borrow_mut().push("inner"),
                        || {
                            tick();
                            panic!("test");
                        },
                    );
                }));
                tick();
            },
        );
        tick();
        assert_eq!(*seen.borrow(), ["outer", "inner", "outer"]);
    }
}
