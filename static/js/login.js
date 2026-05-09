document.addEventListener('DOMContentLoaded', function() {
    const usernameInput = document.getElementById('username');
    const rememberCheckbox = document.getElementById('remember');
    
    const savedUsername = localStorage.getItem('rememberedUsername');
    if (savedUsername) {
        usernameInput.value = savedUsername;
        rememberCheckbox.checked = true;
    }
    
    document.querySelector('form').addEventListener('submit', function() {
        if (rememberCheckbox.checked) {
            localStorage.setItem('rememberedUsername', usernameInput.value);
        } else {
            localStorage.removeItem('rememberedUsername');
        }
    });
});
