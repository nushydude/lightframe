#[cfg(windows)]
use std::sync::Mutex;

#[cfg(windows)]
use windows::core::PWSTR;
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows::Win32::System::Power::{
    PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired, PowerSetRequest,
};
#[cfg(windows)]
use windows::Win32::System::SystemServices::POWER_REQUEST_CONTEXT_VERSION;
#[cfg(windows)]
use windows::Win32::System::Threading::{
    POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
};

#[cfg(windows)]
struct DisplayRequest(HANDLE);

// Kernel handles are process-wide and the mutex ensures only one thread uses
// the request at a time. The handle is still cleared and closed by Drop.
#[cfg(windows)]
unsafe impl Send for DisplayRequest {}

#[cfg(windows)]
impl Drop for DisplayRequest {
    fn drop(&mut self) {
        unsafe {
            let _ = PowerClearRequest(self.0, PowerRequestDisplayRequired);
            let _ = CloseHandle(self.0);
        }
    }
}

#[derive(Default)]
pub struct DisplayInhibition {
    #[cfg(windows)]
    request: Mutex<Option<DisplayRequest>>,
}

impl DisplayInhibition {
    pub fn acquire(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            let mut request = self
                .request
                .lock()
                .map_err(|_| "Display inhibition state was poisoned".to_string())?;
            if request.is_some() {
                return Ok(());
            }

            let mut reason = "LightFrame slideshow is running".encode_utf16().collect::<Vec<_>>();
            reason.push(0);
            let context = REASON_CONTEXT {
                Version: POWER_REQUEST_CONTEXT_VERSION,
                Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
                Reason: REASON_CONTEXT_0 { SimpleReasonString: PWSTR(reason.as_mut_ptr()) },
            };
            let handle = unsafe { PowerCreateRequest(&context) }
                .map_err(|error| format!("Failed to create display power request: {error}"))?;
            if let Err(error) = unsafe { PowerSetRequest(handle, PowerRequestDisplayRequired) } {
                unsafe {
                    let _ = CloseHandle(handle);
                }
                return Err(format!("Failed to set display power request: {error}"));
            }
            *request = Some(DisplayRequest(handle));
        }

        Ok(())
    }

    pub fn release(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            let mut request = self
                .request
                .lock()
                .map_err(|_| "Display inhibition state was poisoned".to_string())?;
            request.take();
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::DisplayInhibition;

    #[test]
    fn duplicate_acquire_and_release_are_idempotent() {
        let inhibition = DisplayInhibition::default();
        inhibition.acquire().unwrap();
        inhibition.acquire().unwrap();
        inhibition.release().unwrap();
        inhibition.release().unwrap();
    }

    #[test]
    fn acquire_then_release_is_successful() {
        let inhibition = DisplayInhibition::default();
        inhibition.acquire().unwrap();
        inhibition.release().unwrap();
    }
}
